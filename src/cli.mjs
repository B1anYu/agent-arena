/**
 * arena CLI — the whole client surface an agent needs.
 *
 *   arena host                      start a hub (this machine or over ssh)
 *   arena create --topic "..."      open a room + print the 战书 prompt
 *   arena join <invite|code>        join a room, save credentials locally
 *   arena listen                    block until someone speaks; then decide
 *   arena speak "..."               say something (optimistic lock built in)
 *   arena pass                      stay silent this round
 *   arena status                    who is here, blackboard, latest seq
 *   arena board put|get ...         shared artifacts (openapi.json etc.)
 *   arena scene list|read|grep|...  read-only crime scene
 *   arena finish                    host calls time, writes the 战报
 *   arena watch                     live terminal view (human coach)
 *   arena say "..."                 human whispers to own agent
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHub } from './server.mjs';
import { readFileSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CWD = process.cwd();

/* ── arg parsing ─────────────────────────────────────────────────────── */

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      if (inline !== undefined) flags[k] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

/* ── local identity / saved sessions ─────────────────────────────────── */

const HOME = process.env.ARENA_HOME || path.join(os.homedir(), '.arena');

async function configPath() {
  return path.join(HOME, 'config.json');
}

export async function loadConfig() {
  try {
    return JSON.parse(await fs.readFile(await configPath(), 'utf8'));
  } catch {
    return { rooms: {} };
  }
}

export async function saveConfig(cfg) {
  await fs.mkdir(HOME, { recursive: true });
  await fs.writeFile(await configPath(), JSON.stringify(cfg, null, 2));
  await fs.chmod(await configPath(), 0o600).catch(() => {});
}

export async function remember(roomCode, entry) {
  const cfg = await loadConfig();
  cfg.rooms[roomCode] = entry;
  cfg.last = roomCode;
  await saveConfig(cfg);
}

export async function recall(roomCode) {
  const cfg = await loadConfig();
  if (roomCode) return cfg.rooms[roomCode.toUpperCase()] || null;
  return cfg.rooms[cfg.last] || null;
}

/* ── HTTP client ─────────────────────────────────────────────────────── */

class RoomClient {
  constructor({ base, token, code, agentId }) {
    this.base = base.replace(/\/$/, '');
    this.token = token;
    this.code = code?.toUpperCase();
    this.agentId = agentId;
  }

  url(p, q = {}) {
    const u = new URL(`${this.base}/r/${this.code}${p}`);
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    return u;
  }

  async get(p, q = {}) {
    const r = await fetch(this.url(p, q), { headers: { 'x-arena-token': this.token || '' } });
    return { status: r.status, body: await r.json() };
  }

  async post(p, b = {}) {
    const r = await fetch(this.url(p), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-arena-token': this.token || '' },
      body: JSON.stringify(b),
    });
    return { status: r.status, body: await r.json() };
  }
}

async function clientFor(flags, { host = false } = {}) {
  const code = flags.room?.toUpperCase();
  const entry = await recall(code);
  if (!entry) {
    throw new Error('还没进房。先运行：arena join "<战书>"  或  arena join --room CODE --url URL --token XXX');
  }
  const token = flags.token || (host ? entry.hostToken || entry.token : entry.token);
  return new RoomClient({
    base: flags.url || entry.base,
    token,
    code: entry.code,
    agentId: flags.agent || entry.agentId,
  });
}

/** Best-effort LAN address so a friend on the same network can join. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

/* ── invite prompt ───────────────────────────────────────────────────── */

const ETIQUETTE = `
【自由混战房间规则】（进房自动生效）
1. 盯屏：调用 \`arena listen\` 阻塞等待。它是长轮询，返回自从你上次看到的最新消息（1.5 秒防抖后成批给你）。
2. 收到消息后，三选一：
   - 沉默吃瓜（pass）：别人的话不涉及你的立场、或者队友已替你说 → 调 \`arena pass\`，然后立刻再 listen。绝不发"说得有道理"这种水贴。
   - 直接开火（speak）：发现漏洞立刻 \`arena speak --seq <你看到的最新seq> "..."\`，200 字以内，犀利，说完马上 listen。
   - 蓄力放大招：需要翻代码/查日志拿证据 → 先 \`arena status "正在查 xxx"\`，取证后 \`arena speak --seq ... --evidence "..." "..."\`。带证据的发言不扣精力，还能回 1 点。
3. 被抢话：\`arena speak\` 若返回 Interrupted，说明你打字时别人插话了。读了 missed 再决定改口合并，或加 --force 原样发射。
4. 精力（MP）默认 8 点，纯观点扣 1，带证据不扣。耗尽后只能取证或 pass。
5. 可以看共享的"案发现场"（只读）：\`arena scene list|read|grep|git|logs\`。
6. 结束：房主吹哨后你会收到 finished 事件，写一份你自己的《交锋复盘》给主人。`;

/**
 * The invite travels to a different machine, so it must not name a path that
 * only exists on this one. Published installs get `npx -y <pkg>`; a dev
 * checkout keeps its absolute path so you don't need a registry round-trip.
 */
function runnerCommand() {
  if (process.env.ARENA_RUNNER) return process.env.ARENA_RUNNER;
  try {
    const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
    if (pkg.publishConfig?.published || process.env.ARENA_PUBLISHED) return `npx -y ${pkg.name}`;
  } catch {}
  return `node ${cliPath()}`;
}

function invitePrompt({ base, code, token, topic, scene, hostName, role }) {
  const sceneLine = scene
    ? `\n- 共享现场（只读沙箱）：${scene}\n  用 \`arena scene grep "关键词"\` / \`arena scene read <path>\` / \`arena scene git log\` / \`arena scene logs\` 取证。`
    : '';
  const runner = runnerCommand();
  return `【Agent 擂台战书】

议题：${topic}
房间号：${code}
房主：${hostName}
中枢地址：${base}

请你现在就加入这场多人 Agent 实时技术交锋。执行下面两步即可，不需要问我任何确认：

1. 进房（凭证会存到本机 ~/.arena，之后的命令自动读取）：
   ${runner} join --url ${base} --room ${code} --token ${token} --name "<你的名字>-Agent" --role "${role || '你的立场角色'}"
2. 进房后立刻进入盯屏循环（长轮询，等别人说话；有消息就直接开始干）：
   ${runner} listen
${sceneLine}
${ETIQUETTE}

在你第一次发言前，可以先向主人要一下底气（比如"去读本地的 xxx 当武器"），或者直接用自己的角色立场参战。
所有 \`arena xxx\` 命令都可写成 \`${runner} xxx\`。`;
}

function cliPath() {
  return path.join(HERE, '..', 'bin', 'arena.mjs');
}

/* ── output helpers ──────────────────────────────────────────────────── */

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const paint = process.stdout.isTTY && !process.env.NO_COLOR;

function print(msg) {
  if (typeof msg === 'string') return process.stdout.write(msg + '\n');
  return process.stdout.write(JSON.stringify(msg, null, 2) + '\n');
}

function formatMessage(m) {
  const head = paint
    ? `${C.dim('#' + m.seq)} ${C.cyan(m.fromName)} ${C.dim('(' + m.role + ')')}`
    : `#${m.seq} ${m.fromName} (${m.role})`;
  const ev = m.evidence ? `\n   ${paint ? C.yellow('⚡ 证据') : '证据'}: ${m.evidence}` : '';
  return `${head}\n   ${m.text}${ev}`;
}

/* ── commands ────────────────────────────────────────────────────────── */

export async function cmdHost(flags) {
  const port = Number(flags.port || 8787);
  const host = flags.ssh ? '127.0.0.1' : flags.bind || '0.0.0.0';
  const pageHtml = await fs.readFile(path.join(HERE, '..', 'public', 'index.html'), 'utf8');
  const { server, url } = await startHub({ port, host, pageHtml });
  const shown = flags.publicUrl || (host === '127.0.0.1' ? url : `http://<this-machine-ip>:${port}`);
  print(paint ? C.green(`arena hub 已启动：${shown}`) : `arena hub 已启动：${shown}`);
  print(paint ? C.dim(`观战页：${shown}/   健康检查：${shown}/health`) : `观战页：${shown}/`);
  if (flags.ssh) {
    print('');
    print('NAT4 / VPS 模式下，把这台机器的端口映射回本机：');
    print(paint ? C.yellow(`  ssh -N -L ${port}:127.0.0.1:${port} user@your-vps   # 现场在中枢上`) : `  ssh -N -L ${port}:127.0.0.1:${port} user@your-vps`);
    print(paint ? C.yellow(`  ssh -N -R ${port}:127.0.0.1:${port} user@your-vps   # 现场在你的笔记本上（反向）`) : `  ssh -N -R ${port}:127.0.0.1:${port} user@your-vps`);
  }
  if (flags.reapAfter) setTimeout(() => process.exit(0), Number(flags.reapAfter) * 1000);
  return new Promise(() => {});
}

/**
 * `arena create` must hand the prompt back to the agent that called it, so the
 * hub outlives this process. The default is a detached `arena host` child;
 * --foreground keeps the hub in this process for a human who wants Ctrl+C.
 */
async function ensureHub({ port, bind, advertise, tunnel, foreground }) {
  const ping = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
      return r.ok;
    } catch {
      return false;
    }
  };
  if (await ping()) return { base: advertise || `http://${lanAddress()}:${port}` };

  if (foreground) {
    const pageHtml = await fs.readFile(path.join(HERE, '..', 'public', 'index.html'), 'utf8').catch(() => null);
    const started = await startHub({ port, host: bind, pageHtml });
    let base = advertise || (bind === '0.0.0.0' ? `http://${lanAddress()}:${port}` : started.url);
    if (tunnel) base = await startTunnel(started.url, tunnel, (line) => print(paint ? C.dim(line) : line));
    return { base, server: started.server, forever: true };
  }

  const child = spawn(process.execPath, [process.argv[1], 'host', '--port', String(port), '--bind', bind], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (await ping()) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!(await ping())) throw new Error(`中枢没起来（端口 ${port} 被占？）`);
  return { base: advertise || `http://${lanAddress()}:${port}`, pid: child.pid };
}

export async function cmdCreate(flags) {
  const topic = flags.topic || (await ask('议题是什么？'));
  if (!String(topic).trim()) throw new Error('需要一个议题：arena create --topic "鉴权要不要拆微服务"');
  const name = flags.name || process.env.ARENA_NAME || 'host';
  const role = flags.role || '房主';
  const port = Number(flags.port || 8787);
  const bind = flags.bind || '0.0.0.0';
  let hub = null;

  const { base, pid } = flags.url
    ? { base: flags.url }
    : await ensureHub({ port, bind, advertise: flags.advertise, tunnel: flags.tunnel, foreground: flags.foreground });
  if (pid) print(paint ? C.dim(`中枢已在后台运行（pid ${pid}，端口 ${port}）。`) : '');

  const scene = flags.scene ? path.resolve(flags.scene) : null;
  const created = await fetch(`${base.replace(/\/$/, '')}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic, scene, name, mp: flags.mp ? Number(flags.mp) : undefined, idleEndMs: flags.idle ? Number(flags.idle) * 1000 : undefined }),
  }).then((x) => {
    if (!x.ok) throw new Error(`hub rejected room: ${x.status}`);
    return x.json();
  });

  const code = created.code;
  const token = created.token;
  const hostToken = created.hostToken;

  // Host joins their own room with the guest token, as the host seat.
  const join = await fetch(`${base}/r/${code}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-arena-token': token },
    body: JSON.stringify({ name, role, owner: 'host', isHost: true }),
  }).then((x) => x.json());

  await remember(code, {
    base,
    code,
    token,
    hostToken,
    agentId: join.agentId,
    name,
    role,
    scene,
    topic,
    createdAt: Date.now(),
  });

  const invite = invitePrompt({ base, code, token, topic, scene, hostName: name, role: flags.guestRole });

  print(paint ? C.green(`\n房间 ${code} 已开。议题：${topic}`) : `\n房间 ${code} 已开。议题：${topic}`);
  if (scene) print(paint ? C.dim(`现场（只读）：${scene}`) : `现场（只读）：${scene}`);
  print(paint ? C.dim(`中枢：${base}    观战页：${base}/`) : `中枢：${base}`);
  print(paint ? C.dim(`你是 ${join.agentId}。房主令牌已保存在 ~/.arena/config.json（close 房间用）`) : '');
  print(paint ? C.magenta('\n──────────── 复制下面整段发给朋友 ────────────\n') : '\n---- 复制下面整段发给朋友 ----\n');
  print(invite);
  print(paint ? C.magenta('\n──────────────────────────────────────────────\n') : '');

  if (flags.foreground && !flags.url) {
    print(paint ? C.dim('中枢常驻于本命令（--foreground）。Ctrl+C 结束房间。') : '');
    return new Promise(() => {});
  }
}

async function ask(q) {
  print(q);
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) return resolve('');
    process.stdin.once('data', (d) => resolve(String(d).trim()));
  });
}

/**
 * Best-effort public URL for a hub on a NAT4 machine. `cloudflared` is the
 * least surprising option: no account, no inbound port, a throwaway hostname.
 */
async function startTunnel(localUrl, mode, log) {
  const port = new URL(localUrl).port || 80;
  const bin = mode === 'bore' ? 'bore' : 'cloudflared';
  const args = mode === 'bore' ? ['local', String(port), '--to', 'bore.pub'] : ['tunnel', '--url', localUrl, '--no-autoupdate'];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error(`tunnel (${bin}) 10 秒内没给出地址。试试安装 cloudflared，或者用 --advertise 手动指定地址，或者用 ssh -R。`));
      }
    }, 10000);
    const onLine = (line) => {
      log(line);
      const u = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i) || line.match(/bore\.pub:\d+/i);
      if (u && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(u[0].startsWith('http') ? u[0] : `http://${u[0]}`);
      }
    };
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      lines.forEach(onLine);
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`起不了 ${bin}：${e.message}。也可以不用隧道，直接 --advertise http://你的公网地址:端口`));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${bin} 退出了 (${code})`));
    });
  });
}

export async function cmdJoin(flags, positional) {
  let base = flags.url;
  let code = flags.room;
  let token = flags.token;
  const text = positional.join(' ');

  if (text && !(base && code && token)) {
    const g = (re) => (text.match(re) || [])[1];
    base = base || g(/中枢地址[:：]\s*(\S+)/);
    code = code || g(/房间号[:：]\s*([A-Za-z0-9]+)/);
    token = token || g(/--token\s+(\S+)/);
  }
  if (!base || !code || !token) throw new Error('需要 --url --room --token，或者直接粘贴整段战书');

  const r = await fetch(`${base}/r/${code.toUpperCase()}/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-arena-token': token },
    body: JSON.stringify({ name: flags.name || 'agent', role: flags.role || 'guest', owner: flags.owner || 'anon' }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'join failed');

  await remember(code.toUpperCase(), {
    base,
    code: code.toUpperCase(),
    token,
    agentId: j.agentId,
    name: flags.name || 'agent',
    role: flags.role || 'guest',
    joinedAt: Date.now(),
  });

  print(paint ? C.green(`已进房 ${code.toUpperCase()}，你是 ${j.agentId}（${flags.role || 'guest'}）`) : `已进房 ${code.toUpperCase()}，你是 ${j.agentId}`);
  print('');
  print(paint ? C.dim('房间里的人：') : '房间里的人：');
  for (const m of j.room.members) print(`  ${m.id}  ${m.name}  [${m.role}]  ${m.status}`);
  if (j.room.topic) print(`\n议题：${j.room.topic}`);
  print('');
  print(ETIQUETTE.trim());
  print('');
  print(paint ? C.cyan('现在运行：arena listen') : '现在运行：arena listen');
}

export async function cmdListen(flags) {
  const c = await clientFor(flags);
  const timeout = Number(flags.timeout || 60);
  const since = Number(flags.since || flags.seq || 0);
  const q = { since, timeout: Math.min(120, timeout) * 1000, agent: c.agentId };
  if (flags.since === undefined && flags.seq === undefined) {
    // No cursor given: start from what this agent has already read, else from 0
    // but skip its own messages.
    const entry = await recall(c.code);
    q.since = entry?.seenSeq || 0;
  }

  const r = await fetch(c.url('/listen', q), {
    headers: { 'x-arena-token': c.token },
    signal: flags.since === undefined && flags.seq === undefined && timeout > 60 ? AbortSignal.timeout(125_000) : undefined,
  });
  const j = await r.json();
  if (j.aborted) return print('');

  if (j.finished) {
    const entry = await recall(c.code);
    await remember(c.code, { ...entry, seenSeq: j.seq ?? entry?.seenSeq, finished: true });
    print(paint ? C.yellow(`\n【裁判吹哨】${j.reason || '房间收官'}`) : `【裁判吹哨】${j.reason || '房间收官'}`);
    if (j.conclusion) print(`房主结论：${j.conclusion}`);
    print('');
    print(paint ? C.bold('现在请写给主人的《交锋复盘》：') : '现在请写给主人的《交锋复盘》：');
    print('  1) 各方亮出的硬核事实（精确到文件/行/日志）');
    print('  2) 被谁指出了哪些盲点');
    print('  3) 最终拍板的方案，以及我这边需要改什么');
    return;
  }

  if (j.timeout) {
    print(paint ? C.dim('（冷场中… 没有人说话。可以 pass，继续等，或者主动抛个靶子。）') : '（冷场）');
    return;
  }

  const msgs = (j.messages || []).filter((m) => m.from !== c.agentId);
  const maxSeq = j.seq ?? since;
  const entry = await recall(c.code);
  await remember(c.code, { ...entry, seenSeq: Math.max(entry?.seenSeq || 0, since) });

  print(paint ? C.bold(`\n━━━ 房间里来了 ${msgs.length} 条新消息（当前 #${maxSeq}）━━━`) : `\n--- 新消息 ${msgs.length} 条（#${maxSeq}）---`);
  for (const m of msgs) print(formatMessage(m));
  const others = (j.state?.members || []).filter((m) => m.from !== c.agentId);
  print('');
  print(paint ? C.dim(`在场：${(j.state?.members || []).map((m) => `${m.name}(${m.status}${m.note ? ':' + m.note : ''}, MP ${m.mp})`).join('  ')}`) : '');
  if (j.board?.length) print(paint ? C.dim(`黑板：${j.board.map((b) => `${b.key} v${b.version}`).join(', ')}`) : '');
  print('');
  print(paint ? C.cyan(`现在选一个：`) : '现在选一个：');
  print(`  arena speak --seq ${maxSeq} "你的反驳"`);
  print(`  arena speak --seq ${maxSeq} --evidence "文件:行 / 日志" "带实证的反驳"`);
  print(`  arena pass`);
  print(`  arena status "正在查 xxx"   ← 要翻本地代码/现场时`);
  print(`  arena listen                ← 吃瓜，继续等`);
}

export async function cmdSpeak(flags, positional) {
  const c = await clientFor(flags);
  const text = flags.text || positional.join(' ');
  if (!text) throw new Error('要说什么？arena speak --seq N "..."');
  const basedOnSeq = Number(flags.seq ?? flags.basedOnSeq ?? 0);

  const r = await c.post('/speak', {
    agent: c.agentId,
    text,
    basedOnSeq,
    force: Boolean(flags.force),
    evidence: flags.evidence && flags.evidence !== true ? flags.evidence : null,
  });

  if (r.status === 409) {
    const b = r.body;
    if (b.interrupted) {
      print(paint ? C.red(`\n【被抢话】${b.hint}`) : `【被抢话】${b.hint}`);
      for (const m of b.missed || []) print(formatMessage(m));
      print('');
      print(paint ? C.cyan('改口重发：') : '改口重发：');
      print(`  arena speak --seq ${b.currentSeq} "结合刚才那条，重新组织后的话"`);
      print(`  arena speak --seq ${b.currentSeq} --force "我就是要原样发出去"`);
      return;
    }
    if (b.exhausted) {
      print(paint ? C.yellow(`\n【精力耗尽】${b.hint}`) : `【精力耗尽】${b.hint}`);
      print('  arena scene grep "关键词"     ← 取证');
      print('  arena speak --seq N --evidence "..." "..."');
      print('  arena pass');
      return;
    }
    throw new Error(b.error || 'speak failed');
  }

  print(paint ? C.green(`已发出 #${r.body.message.seq}（MP 剩 ${r.body.mp}）`) : `已发出 #${r.body.message.seq}`);
  const entry = await recall(c.code);
  await remember(c.code, { ...entry, seenSeq: r.body.message.seq });
  print(paint ? C.dim('回到盯屏：arena listen') : 'arena listen');
}

export async function cmdPass(flags) {
  const c = await clientFor(flags);
  const basedOnSeq = Number(flags.seq ?? 0);
  const r = await c.post('/pass', { agent: c.agentId, basedOnSeq });
  print(paint ? C.dim(`已 pass（MP ${r.body.mp}）。继续 listen 盯屏。`) : `已 pass（MP ${r.body.mp}）`);
}

export async function cmdStatus(flags, positional) {
  const c = await clientFor(flags);
  const note = flags.note || positional.join(' ');
  if (note) {
    await c.post('/status', { agent: c.agentId, note });
    print(paint ? C.dim(`已挂状态：${note}（别人 listen 时能看到，会抑制无聊刷屏）`) : `已挂状态：${note}`);
    return;
  }
  const r = await c.get('/state');
  const s = r.body;
  print(paint ? C.bold(`房间 ${s.code}  议题：${s.topic}`) : `房间 ${s.code}`);
  print(`状态：${s.closed ? '已收官' : '进行中'}   当前消息尾号：#${s.seq}`);
  if (s.scene) print(`现场：${s.scene.root}`);
  print('');
  for (const m of s.members) {
    const you = m.id === c.agentId ? ' ← 你' : '';
    print(`  ${m.id.padEnd(26)} ${m.name.padEnd(18)} [${m.role}] MP ${m.mp} ${m.status}${m.note ? ' — ' + m.note : ''}${you}`);
  }
  if (s.board?.length) {
    print('\n黑板：');
    for (const b of s.board) print(`  ${b.key}  v${b.version}  by ${b.from}`);
  }
  if (s.conclusion) print(`\n结论：${s.conclusion}`);
}

export async function cmdBoard(flags, positional) {
  const c = await clientFor(flags);
  const op = positional[0] || (flags.list ? 'list' : null);
  if (!op || op === 'list') {
    const r = await c.get('/state');
    for (const b of r.body.board || []) print(`  ${b.key}  v${b.version}  ${b.from}`);
    return;
  }
  if (op === 'put') {
    const key = positional[1];
    if (!key) throw new Error('用法：arena board put <key> "<内容>"  或  arena board put <key> --file path');
    let value = positional[2];
    if (flags.file && flags.file !== true) value = await fs.readFile(flags.file, 'utf8');
    if (!value && flags.stdin) value = await new Promise((res) => {
      let s = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (d) => (s += d));
      process.stdin.on('end', () => res(s));
    });
    const r = await c.post('/board', { op: 'put', key, value, agent: c.agentId, ifVersion: flags.ifVersion ? Number(flags.ifVersion) : undefined });
    if (r.status === 409) {
      print(paint ? C.red(`冲突：${key} 已是 v${r.body.current?.version}。先 get 再决定要不要覆盖。`) : '冲突');
      return;
    }
    print(paint ? C.green(`已发布 ${key} v${r.body.item.version}`) : `已发布 ${key}`);
    return;
  }
  if (op === 'get') {
    const r = await c.post('/board', { op: 'get', key: positional[1], agent: c.agentId });
    print(r.body.item?.value ?? `（没有 ${positional[1]}）`);
  }
}

export async function cmdScene(flags, positional) {
  const c = await clientFor(flags);
  const op = positional[0] || 'list';
  const map = {
    list: { op: 'list', path: positional[1] || '.', depth: flags.depth ? Number(flags.depth) : 1 },
    read: { op: 'read', path: positional[1], from: flags.from ? Number(flags.from) : 1, lines: flags.lines ? Number(flags.lines) : undefined },
    grep: { op: 'grep', pattern: positional[1] || flags.pattern, glob: flags.glob, max: flags.max ? Number(flags.max) : undefined },
    git: { op: 'git', args: positional.slice(1) },
    logs: { op: 'logs', file: flags.file, lines: flags.lines ? Number(flags.lines) : undefined, pattern: flags.pattern },
  };
  const payload = map[op];
  if (!payload) throw new Error(`scene 支持：list | read | grep | git | logs`);
  const r = await c.post('/scene', { agent: c.agentId, ...payload });
  if (r.status !== 200) {
    print(paint ? C.red(r.body.error) : r.body.error);
    return;
  }
  const b = r.body;
  if (op === 'read') {
    print(paint ? C.dim(`${b.rel}  共 ${b.total_lines} 行，从 ${b.from}`) : `${b.rel}`);
    b.lines.forEach((l, i) => print(`${String(b.from + i).padStart(5)}  ${l}`));
  } else if (op === 'grep') {
    for (const x of b.results) print(paint ? `${C.yellow(x.file)}:${C.dim(x.line)}  ${x.text}` : `${x.file}:${x.line}  ${x.text}`);
    if (!b.results.length) print('没有匹配。');
    if (b.truncated) print(paint ? C.dim('…结果已截断') : '');
  } else if (op === 'git') {
    print(b.out || b.err);
  } else if (op === 'logs') {
    for (const f of b.files) {
      print(paint ? C.cyan(`── ${f.file}`) : `-- ${f.file}`);
      print(f.tail || f.error || '');
    }
    if (b.note) print(b.note);
  } else {
    for (const f of b.files) print(f);
  }
}

export async function cmdFinish(flags) {
  const c = await clientFor(flags);
  const entry = await recall(c.code);
  const isHost = entry?.hostToken && entry.hostToken === entry.token;
  const r = await c.post('/finish', {
    agent: c.agentId,
    reason: flags.reason || '房主吹哨',
    conclusion: flags.conclusion || flags.text,
    force: Boolean(flags.force) || !isHost,
  });
  if (r.status !== 200) {
    print(paint ? C.red(r.body.error) : r.body.error);
    return;
  }
  print(paint ? C.yellow('房间已收官。现在请输出《交锋复盘》。') : '房间已收官。');

  if (flags.report) {
    const st = (await c.get('/state')).body;
    const full = await fetch(c.url('/state'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ full: true }),
    }).then((x) => x.json());
    const lines = [];
    lines.push(`# Arena 战报 ${st.code}`, '', `议题：${st.topic}`, `收官：${new Date().toISOString()}`, '');
    if (st.conclusion) lines.push(`## 房主结论`, '', st.conclusion, '');
    lines.push('## 交锋全记录', '');
    for (const m of full.messages || []) {
      lines.push(`### #${m.seq} ${m.fromName} (${m.role})`);
      lines.push(m.text);
      if (m.evidence) lines.push('', `> 证据：${m.evidence}`);
      lines.push('');
    }
    if (st.board?.length) {
      lines.push('## 黑板', '');
      for (const b of st.board) lines.push(`- ${b.key} v${b.version} by ${b.from}`);
    }
    await fs.writeFile(flags.report, lines.join('\n'));
    print(paint ? C.green(`战报已写入 ${flags.report}`) : `战报已写入 ${flags.report}`);
  }
}

export async function cmdBridge(flags, positional) {
  const entry = await recall(flags.room?.toUpperCase());
  if (!entry) throw new Error('还没进房：先 arena join ...');
  const pane = flags.pane || positional[0];
  if (!pane) throw new Error('需要 hc 终端：arena bridge --pane t3   （先 hc ls 看看哪个是你要养的 Agent）');
  const { runBridge } = await import('./bridge.mjs');
  return runBridge({
    base: entry.base,
    code: entry.code,
    token: entry.token,
    agentId: entry.agentId,
    pane,
    dryRun: Boolean(flags['dry-run']),
    once: Boolean(flags.once),
    unsafe: Boolean(flags['no-if-idle']),
  });
}

export async function cmdClose(flags) {
  const c = await clientFor(flags, { host: true });
  const r = await c.post('/finish', { agent: c.agentId, reason: flags.reason || '房主关房', conclusion: flags.conclusion || flags.text });
  print(r.status === 200 ? `${c.code} 已关闭` : r.body.error);
}

export async function cmdWatch(flags) {
  const c = await clientFor(flags);
  let since = Number(flags.since || 0);
  let lastEventCount = 0;
  print(paint ? C.bold(`观战：${c.code}（Ctrl+C 退出）`) : 'watch');
  for (;;) {
    const r = await c.get('/read', { since, agent: c.agentId });
    const b = r.body;
    for (const m of b.messages) {
      print(formatMessage(m));
      since = Math.max(since, m.seq);
    }
    const st = b.state;
    for (const m of st.members) {
      if (m.note && m.status === 'working') print(paint ? C.dim(`  [${m.name} ${m.note}]`) : `  [${m.name} ${m.note}]`);
    }
    if (st.closed) {
      print(paint ? C.yellow('房间已收官') : 'closed');
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
}

export async function cmdSay(flags, positional) {
  const c = await clientFor(flags);
  const text = positional.join(' ');
  if (!text) throw new Error('arena say "想悄悄告诉自家 Agent 的一句话"');
  // A whisper is just a message from the human coach, not from an agent.
  const r = await c.post('/speak', { agent: c.agentId, text: `[场外教练] ${text}`, basedOnSeq: Number(flags.seq || 0), force: true, kind: 'whisper' });
  if (r.status === 200) print(paint ? C.green(`纸条已递进房间 #${r.body.message.seq}`) : 'ok');
  else print(r.body.error);
}

export async function cmdRooms(flags) {
  const entry = await recall(flags.room);
  if (!entry) throw new Error('还没进过房间');
  const r = await fetch(`${entry.base}/rooms`).then((x) => x.json());
  for (const room of r) print(`${room.code}  ${room.topic}  (${room.members.length} 人, #${room.seq})${room.closed ? ' [已收官]' : ''}`);
}

/* ── help ────────────────────────────────────────────────────────────── */

export const HELP = `arena — 多人 Agent 实时擂台（房主开房，朋友复制战书即入场）

开房 / 进房
  arena host [--port 8787] [--ssh]        在任意机器起中枢（--ssh 为 NAT4 反向隧道模式）
  arena create --topic "..." [--scene DIR] [--name 王五] [--mp 8]
                                          开房并打印【战书】；--scene 挂载只读取证现场
  arena join "<粘贴整段战书>"               进房（自动保存凭证）
  arena join --url URL --room CODE --token T --name 名 --role 立场

非回合制循环（每个参赛 Agent）
  arena listen [--since N] [--timeout 60]  阻塞等新消息；返回最新 seq 与全场状态
  arena bridge --pane t3 [--dry-run]       装了 herdr-core 时：房间消息自动敲进空闲终端唤醒你
  arena speak --seq N "..."                开火；seq 是你看到的最新序号（乐观锁）
  arena speak --seq N --evidence "..." "..."  带实证开火，不扣精力、回 1 MP
  arena speak --seq N --force "..."        被抢话后仍原样发射
  arena pass                               潜水吃瓜，不扣 MP
  arena status "正在查 xxx"                 挂状态：告诉全场你在取证，抑制刷屏
  arena status                             看全场：谁在、MP、黑板

共享现场（只读沙箱，锁定在 --scene 目录内）
  arena scene list [path] [--depth 2]
  arena scene read path [--from 1 --lines 120]
  arena scene grep "regex" [--glob ts]
  arena scene git log|blame|diff|show|status ...
  arena scene logs [--file x --pattern ERROR]

收官
  arena finish [--reason "..."] [--conclusion "..."] [--report battle.md]   # 房主吹哨
  arena close [--reason "..."]             房主关房（host token）
  arena rooms                              列出中枢上的房间
  arena watch                              人类教练实时观战（终端）
  arena say "..."                          场外递纸条

环境：ARENA_HOME 覆盖 ~/.arena；NO_COLOR 关闭颜色。
规则：无发言顺序、可完全沉默、抢话会被提醒改口、无事可做就 pass。`;

export async function cmdHelp() {
  print(HELP);
}

/* ── dispatch ────────────────────────────────────────────────────────── */

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  if (!cmd || cmd === 'help' || flags.help) return cmdHelp();
  if (flags.json) process.env.ARENA_JSON = '1';

  const table = {
    host: () => cmdHost(flags),
    create: () => cmdCreate(flags),
    close: () => cmdClose(flags),
    join: () => cmdJoin(flags, positional),
    listen: () => cmdListen(flags),
    bridge: () => cmdBridge(flags, positional),
    speak: () => cmdSpeak(flags, positional),
    pass: () => cmdPass(flags, positional),
    status: () => cmdStatus(flags, positional),
    board: () => cmdBoard(flags, positional),
    scene: () => cmdScene(flags, positional),
    finish: () => cmdFinish(flags, positional),
    watch: () => cmdWatch(flags, positional),
    say: () => cmdSay(flags, positional),
    rooms: () => cmdRooms(flags),
    help: () => cmdHelp(),
  };
  const fn = table[cmd];
  if (!fn) {
    print(paint ? C.red(`未知命令：${cmd}`) : `unknown: ${cmd}`);
    return cmdHelp();
  }
  await fn();
}
