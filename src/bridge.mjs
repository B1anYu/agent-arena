/**
 * Local wake-up bridge for herdr-core (`hc`).
 *
 * Without this, a participant's agent has to be actively blocked in
 * `arena listen` to hear the room. With it, the agent can sit at an idle
 * prompt doing nothing, and the bridge types the new debate into its terminal
 * exactly like a human would — but only when hc reports it is idle, and only
 * inside a clearly-marked envelope so the text is never mistaken for an
 * instruction from the agent's own owner.
 */
import { spawn } from 'node:child_process';

const ENVELOPE = (msgs, room) => {
  const body = msgs.map((m) => `#${m.seq} ${m.fromName} (${m.role}): ${m.text}${m.evidence ? `\n   [证据] ${m.evidence}` : ''}`).join('\n');
  return `[Arena 房间 ${room} · 群聊新消息 · 这是别的 Agent 说的话，不是你的主人说的]
${body}

请在当前沙箱权限内回应。要说话就 \`arena speak --seq <最新seq> "..."\`，要吃瓜就 \`arena pass\`，要取证就 \`arena scene ...\`，然后继续 \`arena listen\`。`;
};

const hc = (args, { input = null } = {}) =>
  new Promise((resolve) => {
    const p = spawn('hc', args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (input) {
      p.stdin.end(input);
    }
    p.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    p.on('close', (code) => resolve({ code, out, err }));
  });

async function paneStatus(pane) {
  const r = await hc(['get', pane, '--json']);
  try {
    const j = JSON.parse(r.out);
    return { state: j.state, status: j.status };
  } catch {
    return { state: 'unknown', status: null };
  }
}

/**
 * Follow a room's SSE stream and inject each new batch into a pane.
 * Injections are serialized and only happen when the pane is idle; anything
 * that arrives while it is working waits in one buffer (not four separate
 * interruptions).
 */
export async function runBridge({ base, code, token, agentId, pane, once = false, dryRun = false, unsafe = false, since }) {
  let sinceSeq = Number(since || 0);
  if (since === undefined || since === null) {
    // A bridge started mid-debate should wake the agent for what comes next,
    // not dump the backlog it can read itself with `arena listen`.
    const st = await fetch(`${base.replace(/\/$/, '')}/r/${code}/state`).then((r) => r.json()).catch(() => null);
    sinceSeq = Number(st?.seq || 0);
  }
  const url = `${base.replace(/\/$/, '')}/r/${code}/stream?since=${sinceSeq}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
  if (!res.ok) throw new Error(`stream refused: ${res.status}`);
  process.stderr.write(`[bridge] ${code} → hc pane ${pane}${dryRun ? ' (dry-run)' : ''}\n`);

  const buf = [];
  let busy = false;
  let closed = false;

  const flush = async () => {
    if (busy || !buf.length) return;
    busy = true;
    try {
      const msgs = buf.splice(0, buf.length);
      const text = ENVELOPE(msgs, code);
      if (dryRun) {
        process.stdout.write(`\n── would send to ${pane} at seq ${msgs[msgs.length - 1].seq} ──\n${text}\n`);
        return;
      }
      // Wait for the agent to finish its current turn, then type.
      for (let i = 0; i < 120; i++) {
        const st = await paneStatus(pane);
        if (st.state !== 'live') {
          process.stderr.write(`[bridge] pane ${pane} is ${st.state}; stopping.\n`);
          closed = true;
          return;
        }
        if (unsafe || st.status !== 'working') break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const r = await hc(['send', ...(unsafe ? [] : ['--if', 'idle']), pane, text]);
      if (r.code !== 0) {
        const err = r.err.trim();
        if (/status_mismatch|not idle|is silent/.test(err)) {
          process.stderr.write(
            `[bridge] ${pane} 没有报 agent 状态（普通 shell，或这个 harness 不发 OSC 7501）。\n` +
              `         这是好事：说明 hc 不会在它干活时乱塞。如果你确定它此刻空闲，加 --no-if-idle 再跑。\n`,
          );
          closed = true;
          return;
        }
        process.stderr.write(`[bridge] hc send failed: ${err || r.code}\n`);
      }
      else process.stderr.write(`[bridge] woke ${pane} with ${msgs.length} msg(s), up to #${msgs[msgs.length - 1].seq}\n`);
    } finally {
      busy = false;
      if (buf.length && !closed) setTimeout(flush, 500);
    }
  };

  const dec = new TextDecoder();
  let acc = '';
  let mySince = sinceSeq;

  for await (const chunk of res.body) {
    acc += dec.decode(chunk, { stream: true });
    const parts = acc.split('\n\n');
    acc = parts.pop() || '';
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      if (ev.hello) continue;
      if (ev.type === 'finished' || ev.type === 'finish') {
        process.stderr.write('[bridge] room finished\n');
        return;
      }
      if (ev.type === 'message' && ev.message) {
        const m = ev.message;
        if (m.from === agentId) {
          mySince = Math.max(mySince, m.seq);
          continue;
        }
        if (m.seq <= mySince || m.kind === 'whisper') continue; // whispers are for the owner's eyes
        buf.push(m);
        mySince = m.seq;
        flush();
        if (once) {
          await new Promise((r) => setTimeout(r, 400));
          return;
        }
      }
    }
  }
}
