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

// spawn reports a missing binary as an `error` event, not a throw. Without
// this flag a missing `hc` looks like an ordinary failed send and the caller
// retries it forever.
const SPAWN_FAILURES = new Set(['ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR']);

const hc = (args, { input = null } = {}) =>
  new Promise((resolve) => {
    const p = spawn('hc', args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let spawnError = null;
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    if (input) {
      p.stdin.end(input);
    }
    p.on('error', (e) => {
      spawnError = e.code || 'SPAWN';
      err = e.message;
    });
    p.on('close', (code) => resolve({ code, out, err, spawnError, missing: SPAWN_FAILURES.has(spawnError) }));
  });

/**
 * Normalise what `hc get <pane> --json` reports.
 *
 * The status is a nested object (or null), never a bare string:
 *   working  {"state":"live","status":{"app":"claude-code","state":"working"}}
 *   idle     {"state":"live","status":{"app":"claude-code","state":"idle"}}
 *   done     {"state":"live","status":{"app":"claude-code","state":"done"}}
 *   shell    {"state":"live","status":null}
 *
 * `hc ls --json` flattens the same field to a bare string. We read `get`
 * only, but the flattened shape is accepted defensively so the two can never
 * be silently mixed up.
 *
 * Returns 'gone' | 'working' | 'idle' | 'done' | 'unknown'.
 */
export function classifyPane(json) {
  if (!json) return 'unknown';
  if (json.state && json.state !== 'live') return 'gone';
  const s = json.status;
  if (s === null || s === undefined) return 'unknown';
  const inner = typeof s === 'string' ? s : typeof s === 'object' ? s.state : null;
  if (inner === 'working' || inner === 'idle' || inner === 'done') return inner;
  return 'unknown';
}

/**
 * hc refuses `--if idle` on a pane whose status is `done` — "t1 is done, not
 * idle", exit 10, nothing typed. So the guard only goes on a real idle.
 */
export function sendGuard(mode, unsafe) {
  return mode === 'idle' && !unsafe ? ['--if', 'idle'] : [];
}

/**
 * Classify an hc failure from its JSON error envelope.
 *
 * `missing` and `not_found` are terminal: retrying cannot fix either, and
 * retrying `not_found` is what produced a 2-second infinite loop against a
 * pane name that does not exist. `status_mismatch` is the only recoverable
 * one — the agent went back to working while we were typing, so the batch is
 * worth resending.
 */
export function hcErrorKind(result) {
  if (result?.missing) return 'missing';
  const text = `${result?.err || ''}\n${result?.out || ''}`.trim();
  if (!text) return null;
  let kind = null;
  try {
    kind = JSON.parse(text.trim())?.error?.kind ?? null;
  } catch {
    // hc prints a plain sentence when the failure never reached the daemon.
  }
  if (kind === 'not_found' || kind === 'status_mismatch') return kind;
  if (/status_mismatch|not idle|is silent/.test(text)) return 'status_mismatch';
  return null;
}

async function readPane(pane) {
  const r = await hc(['get', pane, '--json']);
  if (r.missing) return { kind: 'missing', state: r.spawnError };
  if (hcErrorKind(r) === 'not_found') return { kind: 'gone', state: `no terminal "${pane}"` };
  if (!r.out.trim()) return { kind: 'unknown', state: 'no-output' };
  try {
    const j = JSON.parse(r.out);
    return { kind: classifyPane(j), state: j?.state ?? 'unknown' };
  } catch {
    return { kind: 'unknown', state: 'unreadable' };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  // Aborting the fetch is the only reliable way to interrupt an in-flight
  // SSE read: calling cancel() on the body after `for await` has taken the
  // stream throws, and a locked stream can't be cancelled at all.
  const ctrl = new AbortController();
  const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: ctrl.signal });
  if (!res.ok) throw new Error(`stream refused: ${res.status}`);
  process.stderr.write(`[bridge] ${code} → hc pane ${pane}${dryRun ? ' (dry-run)' : ''}\n`);

  const buf = [];
  let busy = false;
  let retryAt = 0;
  // Set when the pane is gone, hc is missing, or the harness reports no
  // status at all: none of those recover, so the stream is torn down instead
  // of sitting forever.
  let stop = null;

  const stopBridge = (why) => {
    if (stop) return;
    stop = why;
    process.stderr.write(`[bridge] ${why}\n`);
    // Make stop take effect now: an idle SSE stream only yields on its 15s
    // ping, so without this the process lingers long after deciding to quit.
    ctrl.abort();
  };

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
      if (Date.now() < retryAt) {
        buf.unshift(...msgs);
        setTimeout(flush, retryAt - Date.now());
        return;
      }
      // Wait for the agent to finish its current turn, then type.
      //
      // `done` is ready too, but it is NOT idle: hc answers `--if idle` on a
      // done pane with "t1 is done, not idle" (exit 10, nothing typed). So
      // done is sent unguarded instead of waiting for the pane to drift back
      // to idle, which may not happen for a long time. That is safe because
      // done means the agent has already handed control back and is parked on
      // its prompt — exactly the moment a human would type into it.
      let mode = 'unknown';
      for (let i = 0; i < 120; i++) {
        const st = await readPane(pane);
        mode = st.kind;
        if (mode === 'missing') {
          stopBridge(`没找到 hc（${st.state}）。先装 herdr-core 并确认 PATH 里有 hc，再运行 arena bridge。`);
          return;
        }
        if (mode === 'gone') {
          stopBridge(`找不到终端 ${pane}（${st.state}）。用 hc ls 确认名字后重跑 arena bridge。`);
          return;
        }
        if (i > 0 && i % 10 === 0) {
          process.stderr.write(`[bridge] 正在等 ${pane} 空闲，已等 ${i} 秒…\n`);
        }
        // unsafe: send regardless of status. unknown: this harness reports no
        // OSC 7501 status (a plain shell), so waiting can never succeed —
        // fall through and let hc's own guard be the judge.
        if (unsafe || mode !== 'working') break;
        await sleep(1000);
      }
      if (!unsafe && mode === 'working') {
        buf.unshift(...msgs);
        retryAt = Date.now() + 5000;
        process.stderr.write(`[bridge] ${pane} 忙了 120 秒还没回到空闲，这批 ${msgs.length} 条退回队列，5 秒后再试。\n`);
        return;
      }

      const r = await hc(['send', ...sendGuard(mode, unsafe), pane, text]);
      const kind = hcErrorKind(r);
      if (kind === 'missing') {
        // Checked before the exit code: a missing binary makes spawn report
        // `error` and then `close(-2)`, so `code` can never be 0.
        stopBridge(`没找到 hc（${r.spawnError}）。先装 herdr-core 并确认 PATH 里有 hc，再运行 arena bridge。`);
        return;
      }
      if (kind === 'not_found') {
        // The pane name is wrong, or the terminal died after we started.
        // Retrying can never fix it.
        stopBridge(`找不到终端 ${pane}（not_found）。用 hc ls 确认名字后重跑 arena bridge。`);
        return;
      }
      if (r.code !== 0) {
        const err = r.err.trim();
        // Only a real null status means "this harness has no OSC 7501 to
        // report". Anything else was a genuine race — most likely the agent
        // went from done/idle back to working while we were sending — and
        // must not be reported as a missing-harness problem.
        if (mode === 'unknown' && kind === 'status_mismatch') {
          stopBridge(
            `${pane} 没有报 agent 状态（普通 shell，或这个 harness 不发 OSC 7501）。` +
              `这是好事：说明 hc 不会在它干活时乱塞。如果你确定它此刻空闲，加 --no-if-idle 再跑。`,
          );
          return;
        }
        // Put the batch back so the next flush carries it; a lost batch would
        // mean the agent silently misses part of the argument.
        buf.unshift(...msgs);
        retryAt = Date.now() + 2000;
        process.stderr.write(
          `[bridge] 发送被拒（pane 状态 ${mode}，退出码 ${r.code}），这批 ${msgs.length} 条已退回队列，2 秒后重试。${err ? ' ' + err : ''}\n`,
        );
        return;
      }
      else process.stderr.write(`[bridge] woke ${pane} with ${msgs.length} msg(s), up to #${msgs[msgs.length - 1].seq}\n`);
    } finally {
      busy = false;
      // A failed send deliberately does not stop a retry: the batch is back in
      // buf and there is still work to do.
      if (buf.length && !stop) setTimeout(flush, Math.max(500, retryAt - Date.now()));
    }
  };

  const dec = new TextDecoder();
  let acc = '';
  let mySince = sinceSeq;

  try {
    for await (const chunk of res.body) {
      if (stop) return;
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
            await sleep(400);
            return;
          }
        }
      }
      if (stop) return;
    }
  } catch (e) {
    // An abort is how stopBridge unwinds; anything else is a real failure.
    if (!stop) throw e;
  }
}
