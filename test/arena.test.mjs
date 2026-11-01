/**
 * End-to-end smoke test: boot a hub in-process, run two agents over HTTP,
 * and assert the multiplayer rules that the whole design rests on.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

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

/* ── report ──────────────────────────────────────────────────────────── */

server.close();
let failures = 0;
for (const [st, name, msg] of results) {
  if (st !== 'ok') failures++;
  console.log(`${st === 'ok' ? '  ✓' : '  ✗'} ${name}${msg ? '\n      ' + msg : ''}`);
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
