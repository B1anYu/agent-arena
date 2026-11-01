/**
 * End-to-end smoke test: boot a hub in-process, run two agents over HTTP,
 * and assert the multiplayer rules that the whole design rests on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { classifyPane, sendGuard, hcErrorKind } from '../src/bridge.mjs';

const port = 18000 + Math.floor(Math.random() * 2000);
const base = `http://127.0.0.1:${port}`;
const server = createServer();
await new Promise((r) => server.listen(port, '127.0.0.1', r));

const call = async (p, b, token) => {
  const r = await fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-arena-token': token } : {}) },
    body: JSON.stringify(b || {}),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (p, token) => (await fetch(`${base}${p}`, { headers: { 'x-arena-token': token || '' } })).json();

const results = [];
const test = async (name, fn) => {
  try {
    await fn();
    results.push(['ok', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
  }
};

/* ── setup ───────────────────────────────────────────────────────────── */

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'arena-scene-'));
await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
await fs.writeFile(path.join(tmp, 'src', 'order.ts'), 'export const pool = { maxOpenConns: 5 };\n// timeout missing\n');
await fs.writeFile(path.join(tmp, '.env'), 'API_KEY=super-secret-1234567890\n');
await fs.mkdir(path.join(tmp, 'logs'));
await fs.writeFile(path.join(tmp, 'logs', 'error.log'), 'upstream prematurely closed connection\n');

let room, hostTok, guestTok, host, guest;

await test('hub opens a room', async () => {
  const r = await call('/rooms', { topic: '订单 502 是谁的锅', scene: tmp, name: '房主' });
  assert.equal(r.status, 200);
  assert.match(r.body.code, /^[A-Z0-9]{4}$/);
  const a = await call(`/r/${r.body.code}/join`, { name: '房主', role: '房主' }, r.body.token);
  const g = await call(`/r/${r.body.code}/join`, { name: '老王', role: '后端' }, r.body.token);
  room = r.body.code;
  hostTok = r.body.hostToken;
  const tok = r.body.token;
  guestTok = tok;
  host = a.body.agentId;
  guest = g.body.agentId;
});

await test('join requires a token', async () => {
  const r = await call(`/r/${room}/join`, { name: 'x' });
  assert.equal(r.status, 401);
});

await test('speak publishes and assigns #1', async () => {
  const r = await call(`/r/${room}/speak`, { agent: host, text: '单体省事', basedOnSeq: 0 }, guestTok);
  assert.equal(r.status, 200);
  assert.equal(r.body.message.seq, 1);
});

await test('optimistic lock rejects a stale speak', async () => {
  const r = await call(`/r/${room}/speak`, { agent: guest, text: '但是权限隔离', basedOnSeq: 0 }, guestTok);
  assert.equal(r.status, 409);
  assert.equal(r.body.interrupted, true);
  assert.equal(r.body.currentSeq, 1);
  assert.equal(r.body.missed.length, 1);
});

await test('force bypasses the lock', async () => {
  const r = await call(`/r/${room}/speak`, { agent: guest, text: '原样发射', basedOnSeq: 0, force: true }, guestTok);
  assert.equal(r.status, 200);
  assert.equal(r.body.message.seq, 2);
});

await test('MP decrements on opinion, evidence refunds', async () => {
  const before = (await get(`/r/${room}/state`)).members.find((m) => m.id === guest).mp;
  await call(`/r/${room}/speak`, { agent: guest, text: '声音大一点', basedOnSeq: 2 }, guestTok);
  const mid = (await get(`/r/${room}/state`)).members.find((m) => m.id === guest).mp;
  assert.equal(mid, before - 1);
  await call(`/r/${room}/speak`, { agent: guest, text: '有实锤', evidence: 'db_pool.go:48', basedOnSeq: 3 }, guestTok);
  const after = (await get(`/r/${room}/state`)).members.find((m) => m.id === guest).mp;
  assert.equal(after, mid + 1);
});

await test('pass is free and visible', async () => {
  const before = (await get(`/r/${room}/state`)).members.find((m) => m.id === host).mp;
  await call(`/r/${room}/pass`, { agent: host, basedOnSeq: 4 }, guestTok);
  const after = (await get(`/r/${room}/state`)).members.find((m) => m.id === host).mp;
  assert.equal(after, before);
});

await test('long-poll resolves the moment someone speaks', async () => {
  const seen = (await get(`/r/${room}/state`)).seq;
  const t0 = Date.now();
  const waiter = get(`/r/${room}/listen?since=${seen}&timeout=5000`, guestTok);
  await new Promise((r) => setTimeout(r, 40));
  await call(`/r/${room}/speak`, { agent: guest, text: '插一句', basedOnSeq: seen }, guestTok);
  const out = await waiter;
  assert.ok(Date.now() - t0 < 4000, 'should not have hit the timeout');
  assert.equal(out.timeout, undefined);
  assert.ok(out.messages.some((m) => m.seq > seen));
});

await test('debounce batches the stream', async () => {
  const seen = (await get(`/r/${room}/state`)).seq;
  await call(`/r/${room}/speak`, { agent: host, text: 'a', basedOnSeq: seen }, guestTok);
  await call(`/r/${room}/speak`, { agent: guest, text: 'b', basedOnSeq: seen + 1 }, guestTok);
  const out = await get(`/r/${room}/read?since=${seen}`, guestTok);
  assert.equal(out.batchOpen, true);
  assert.equal(out.messages.length, 2);
  assert.ok(out.batchEndsAt > Date.now());
});

/* ── scene sandbox ───────────────────────────────────────────────────── */

await test('scene read works inside the root', async () => {
  const r = await call(`/r/${room}/scene`, { agent: guest, op: 'read', path: 'src/order.ts' }, guestTok);
  assert.equal(r.status, 200);
  assert.ok(r.body.lines.join('\n').includes('maxOpenConns'));
});

await test('scene refuses path traversal', async () => {
  for (const p of ['../etc/passwd', '/etc/passwd', 'src/../../etc/passwd']) {
    const r = await call(`/r/${room}/scene`, { agent: guest, op: 'read', path: p }, guestTok);
    assert.equal(r.status, 400, `should refuse ${p}`);
  }
});

await test('scene refuses secret files and secret content', async () => {
  const r1 = await call(`/r/${room}/scene`, { agent: guest, op: 'read', path: '.env' }, guestTok);
  assert.equal(r1.status, 400);
  const r2 = await call(`/r/${room}/scene`, { agent: guest, op: 'grep', pattern: 'API_KEY' }, guestTok);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.results.length, 0, 'secret content must not leak through grep');
  const r3 = await call(`/r/${room}/scene`, { agent: guest, op: 'list', path: '.', depth: 1 }, guestTok);
  assert.ok(!r3.body.files.includes('.env'));
});

await test('scene grep and logs find evidence', async () => {
  const g = await call(`/r/${room}/scene`, { agent: guest, op: 'grep', pattern: 'maxOpenConns' }, guestTok);
  assert.ok(g.body.results.some((x) => x.file.endsWith('order.ts')));
  const l = await call(`/r/${room}/scene`, { agent: guest, op: 'logs', file: 'logs/error.log' }, guestTok);
  assert.ok(l.body.files[0].tail.includes('upstream prematurely closed'));
});

await test('scene git is whitelisted', async () => {
  const r = await call(`/r/${room}/scene`, { agent: guest, op: 'git', args: ['push', '--force'] }, guestTok);
  assert.equal(r.status, 400);
});

/* ── board / finish ──────────────────────────────────────────────────── */

await test('board put/get with version check', async () => {
  const p = await call(`/r/${room}/board`, { op: 'put', key: 'openapi.json', value: '{"v":2}', agent: host }, guestTok);
  assert.equal(p.body.item.version, 1);
  const c = await call(`/r/${room}/board`, { op: 'put', key: 'openapi.json', value: 'x', agent: guest, ifVersion: 0 }, guestTok);
  assert.equal(c.status, 409);
});

await test('only the host can call time', async () => {
  const no = await call(`/r/${room}/finish`, { agent: guest, reason: '偷吹哨' }, guestTok);
  assert.equal(no.status, 403);
  const ws = await fetch(`${base}/r/${room}/state`);
  const before = await ws.json();
  assert.equal(before.closed, false);
  const yes = await call(`/r/${room}/finish`, { agent: host, reason: '收摊', conclusion: '先放单体，加连接池超时' }, hostTok);
  assert.equal(yes.status, 200);
});

await test('a waiter wakes as finished when the room closes', async () => {
  const out = await get(`/r/${room}/listen?since=0&timeout=3000`, guestTok);
  assert.equal(out.finished, true);
});

await test('a closed room refuses new speeches', async () => {
  const r = await call(`/r/${room}/speak`, { agent: guest, text: '还想吵', basedOnSeq: 99, force: true }, guestTok);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /closed/);
});

/* ── bridge: hc status shapes ────────────────────────────────────────── */

// Shapes taken from real `hc get <t> --json` output (hc 0.1.15). The status
// is a nested object or null; the flat string only appears in `hc ls`.
const pane = (inner) => ({ state: 'live', turn: 3, status: inner === undefined ? null : { app: 'claude-code', state: inner } });

await test('classifyPane: working is working', async () => {
  assert.equal(classifyPane(pane('working')), 'working');
});

await test('classifyPane: idle is idle', async () => {
  assert.equal(classifyPane(pane('idle')), 'idle');
});

await test('classifyPane: done is done, not idle', async () => {
  assert.equal(classifyPane(pane('done')), 'done');
});

await test('classifyPane: null status means the harness reports nothing', async () => {
  assert.equal(classifyPane(pane(undefined)), 'unknown');
  assert.equal(classifyPane({ state: 'live', status: null }), 'unknown');
});

await test('classifyPane: an absent status field is not a crash', async () => {
  // Not the same as an explicit null: older hc builds may omit the key.
  assert.equal(classifyPane({ state: 'live' }), 'unknown');
  assert.equal(classifyPane({ state: 'live', turn: 4, app: 'x' }), 'unknown');
});

await test('classifyPane: a dead pane is gone', async () => {
  assert.equal(classifyPane({ state: 'finished', status: null }), 'gone');
  assert.equal(classifyPane({ state: 'dead' }), 'gone');
});

await test('classifyPane: tolerates the flat hc ls shape', async () => {
  assert.equal(classifyPane({ state: 'live', status: 'working' }), 'working');
  assert.equal(classifyPane({ state: 'live', status: 'idle' }), 'idle');
});

await test('classifyPane: never reads the nested object as a bare string', async () => {
  // The original bug: status !== 'working' was always true with an object,
  // so the bridge never waited for a busy agent.
  assert.notEqual(pane('working').status, 'working');
  assert.equal(classifyPane(pane('working')) === 'working', true);
});

await test('sendGuard: --if idle only on a real idle', async () => {
  assert.deepEqual(sendGuard('idle', false), ['--if', 'idle']);
});

await test('sendGuard: done must not carry --if idle (hc rejects it)', async () => {
  // Verified against hc 0.1.15: `hc send --if idle` on a done pane returns
  // {"error":{"kind":"status_mismatch","message":"<t> is done, not idle"}}
  // with exit code 10 and types nothing.
  assert.deepEqual(sendGuard('done', false), []);
});

await test('sendGuard: working and unknown send unguarded', async () => {
  assert.deepEqual(sendGuard('working', false), []);
  assert.deepEqual(sendGuard('unknown', false), []);
});

await test('sendGuard: --no-if-idle disables the guard', async () => {
  assert.deepEqual(sendGuard('idle', true), []);
});

// Error envelopes copied from real hc 0.1.15 output.
await test('hcErrorKind: a missing binary is terminal', async () => {
  assert.equal(hcErrorKind({ code: -2, out: '', err: 'spawn hc ENOENT', spawnError: 'ENOENT', missing: true }), 'missing');
});

await test('hcErrorKind: not_found is terminal, not retryable', async () => {
  // `hc get bogus --json` → exit 3. Retrying this forever was a real bug.
  const out = '{"error":{"hint":"see `hc ls --all`","kind":"not_found","message":"no terminal \\"bogus\\""}}';
  assert.equal(hcErrorKind({ code: 3, out, err: '' }), 'not_found');
});

await test('hcErrorKind: status_mismatch is the recoverable one', async () => {
  const out = '{"error":{"hint":"nothing was typed","kind":"status_mismatch","message":"t1 is done, not idle"}}';
  assert.equal(hcErrorKind({ code: 10, out, err: '' }), 'status_mismatch');
});

await test('hcErrorKind: a successful send has no kind', async () => {
  assert.equal(hcErrorKind({ code: 0, out: '{}', err: '' }), null);
});

/* ── host controls ───────────────────────────────────────────────────── */

// A second, independent room so these cases can't disturb the one above.
let ctl, ctlHost, ctlGuest, ctlTok, ctlHostTok, ctlGuestTok;

await test('host console room opens', async () => {
  const r = await call('/rooms', { topic: '控制台', scene: tmp, name: '房主' });
  ctl = r.body.code;
  ctlHostTok = r.body.hostToken;
  ctlTok = r.body.token;
  ctlHost = (await call(`/r/${ctl}/join`, { name: '房主', role: '房主' }, ctlTok)).body.agentId;
  ctlGuest = (await call(`/r/${ctl}/join`, { name: '老王', role: '后端' }, ctlTok)).body.agentId;
  ctlGuestTok = ctlTok;
  assert.ok(ctl);
});

await test('a guest cannot change settings', async () => {
  const r = await call(`/r/${ctl}/control`, { settings: { mp: 1 } }, ctlGuestTok);
  assert.equal(r.status, 403);
  const st = await get(`/r/${ctl}/state`, ctlGuestTok);
  assert.equal(st.settings.mp, 8);
});

await test('the host can change settings, and they apply', async () => {
  const r = await call(`/r/${ctl}/control`, { settings: { mp: 3, maxMessageChars: 50 } }, ctlHostTok);
  assert.equal(r.status, 200);
  assert.ok(r.body.changed.includes('mp'));
  const who = (await get(`/r/${ctl}/state`)).members.find((m) => m.id === ctlGuest);
  assert.equal(who.mp, 3, 'existing members get clamped to the new cap');
});

await test('maxMessageChars rejects a wall of text', async () => {
  const r = await call(`/r/${ctl}/speak`, { agent: ctlGuest, text: 'x'.repeat(80), basedOnSeq: 0 }, ctlGuestTok);
  assert.equal(r.status, 409);
  assert.equal(r.body.tooLong, true);
});

await test('the host can mute and unmute a guest', async () => {
  await call(`/r/${ctl}/member`, { id: ctlGuest, disabled: true }, ctlHostTok);
  const blocked = await call(`/r/${ctl}/speak`, { agent: ctlGuest, text: '还想说', basedOnSeq: 0 }, ctlGuestTok);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.muted, true);
  await call(`/r/${ctl}/member`, { id: ctlGuest, disabled: false }, ctlHostTok);
  const ok = await call(`/r/${ctl}/speak`, { agent: ctlGuest, text: '能说了', basedOnSeq: 0 }, ctlGuestTok);
  assert.equal(ok.status, 200);
});

await test('a guest cannot mute anyone, not even themselves into power', async () => {
  const r = await call(`/r/${ctl}/member`, { id: ctlHost, disabled: true }, ctlGuestTok);
  assert.equal(r.status, 403);
});

await test('the host cannot be removed, and a removed guest is blocked', async () => {
  // Own room: removal is permanent, so it must not leak into later cases.
  const r5 = await call('/rooms', { topic: '移人', name: '房主' });
  const code5 = r5.body.code;
  const tok5 = r5.body.token;
  const hostSeat = (await call(`/r/${code5}/join`, { name: '房主', role: '房主', isHost: true }, tok5)).body.agentId;
  const g5 = (await call(`/r/${code5}/join`, { name: '老王' }, tok5)).body.agentId;
  const selfRemove = await call(`/r/${code5}/member`, { id: g5, op: 'remove' }, tok5);
  assert.equal(selfRemove.status, 403, 'a guest cannot remove anyone');

  const hostGone = await call(`/r/${code5}/member`, { id: hostSeat, op: 'remove' }, r5.body.hostToken);
  assert.equal(hostGone.status, 400);
  await call(`/r/${code5}/member`, { id: g5, op: 'remove' }, r5.body.hostToken);
  const blocked = await call(`/r/${code5}/speak`, { agent: g5, text: '我还在吗', basedOnSeq: 0 }, tok5);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.removed, true);
});

await test('guest finish is refused unless the host allows it', async () => {
  const r6 = await call('/rooms', { topic: '收官权限', name: '房主' });
  const code6 = r6.body.code;
  const tok6 = r6.body.token;
  await call(`/r/${code6}/join`, { name: '房主', role: '房主', isHost: true }, tok6);
  const g6 = (await call(`/r/${code6}/join`, { name: '老王' }, tok6)).body.agentId;
  const no = await call(`/r/${code6}/finish`, { agent: g6, reason: '偷吹哨', force: true }, tok6);
  assert.equal(no.status, 403);
  await call(`/r/${code6}/control`, { settings: { allowGuestFinish: true } }, r6.body.hostToken);
  const yes = await call(`/r/${code6}/finish`, { agent: g6, reason: '房主允许' }, tok6);
  assert.equal(yes.status, 200);
});

await test('closing observer access blocks anonymous /state', async () => {
  const r2 = await call('/rooms', { topic: '私密房间', name: '房主' });
  const code2 = r2.body.code;
  await call(`/r/${code2}/join`, { name: '房主', role: '房主' }, r2.body.token);
  const before = await fetch(`${base}/r/${code2}/state`);
  assert.equal(before.status, 200, 'open by default');
  await call(`/r/${code2}/control`, { settings: { openObserver: false } }, r2.body.hostToken);
  const after = await fetch(`${base}/r/${code2}/state`);
  assert.equal(after.status, 401, 'closed once the host says so');
  const withTok = await fetch(`${base}/r/${code2}/state`, { headers: { 'x-arena-token': r2.body.token } });
  assert.equal(withTok.status, 200, 'participants still see it');
});

await test('scene policy: deny hides a path, allow narrows it', async () => {
  await call(`/r/${ctl}/control`, { settings: { sceneAllow: null, sceneDeny: ['src'] } }, ctlHostTok);
  const denied = await call(`/r/${ctl}/scene`, { agent: ctlHost, op: 'read', path: 'src/order.ts' }, ctlHostTok);
  assert.equal(denied.status, 403);
  const other = await call(`/r/${ctl}/scene`, { agent: ctlHost, op: 'read', path: 'logs/error.log' }, ctlHostTok);
  assert.equal(other.status, 200, `only the denied prefix is hidden (got ${other.status}: ${JSON.stringify(other.body)})`);

  await call(`/r/${ctl}/control`, { settings: { sceneDeny: [], sceneAllow: ['logs'] } }, ctlHostTok);
  const outside = await call(`/r/${ctl}/scene`, { agent: ctlHost, op: 'read', path: 'src/order.ts' }, ctlHostTok);
  assert.equal(outside.status, 403, 'allowlist hides everything else');

  await call(`/r/${ctl}/control`, { settings: { sceneEnabled: false, sceneAllow: null } }, ctlHostTok);
  const off = await call(`/r/${ctl}/scene`, { agent: ctlGuest, op: 'list', path: '.' }, ctlGuestTok);
  assert.equal(off.status, 403);
});

await test('tokenJoinLimit caps how many agents one invite admits', async () => {
  const r3 = await call('/rooms', { topic: '限流', name: '房主' });
  const code3 = r3.body.code;
  await call(`/r/${code3}/control`, { settings: { tokenJoinLimit: 2 } }, r3.body.hostToken);
  const a = await call(`/r/${code3}/join`, { name: 'a' }, r3.body.token);
  const b = await call(`/r/${code3}/join`, { name: 'b' }, r3.body.token);
  const c = await call(`/r/${code3}/join`, { name: 'c' }, r3.body.token);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(c.status, 403, 'third agent on the same invite is refused');
  assert.match(c.body.error, /最多允许 2/);
});

await test('idleEndMs 0 disables the referee', async () => {
  const r4 = await call('/rooms', { topic: '不自动收官', name: '房主', settings: { idleEndMs: 0 } });
  const code4 = r4.body.code;
  const me = (await call(`/r/${code4}/join`, { name: '房主', role: '房主' }, r4.body.token)).body.agentId;
  await call(`/r/${code4}/speak`, { agent: me, text: '开个场', basedOnSeq: 0 }, r4.body.token);
  const st = await get(`/r/${code4}/state`);
  assert.equal(st.settings.idleEndMs, 0);
  assert.equal(st.closed, false);
});

/* ── report ──────────────────────────────────────────────────────────── */

server.close();
let failures = 0;
for (const [st, name, msg] of results) {
  if (st !== 'ok') failures++;
  console.log(`${st === 'ok' ? '  ✓' : '  ✗'} ${name}${msg ? '\n      ' + msg : ''}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
