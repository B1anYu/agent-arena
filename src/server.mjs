/**
 * Arena Hub: a small HTTP server. Every agent is just an HTTP client, so a
 * guest needs no inbound reachability — only outbound. Works behind NAT4.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { Room, roomCode } from './room.mjs';
import { Scene } from './scene.mjs';

const json = (res, code, body, extra = {}) => {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    ...extra,
  });
  res.end(data);
};

/**
 * Headers that keep an SSE response un-buffered through a reverse proxy.
 * `X-Accel-Buffering` is honoured by nginx; `no-transform` stops intermediaries
 * from re-encoding the stream; `Connection: keep-alive` keeps the socket open.
 */
function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'access-control-allow-origin': '*',
  });
}

async function body(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function createServer({ pageHtml = null } = {}) {
  const rooms = new Map();
  const observers = new Set(); // global SSE (arena board + observer page)
  const roomStreams = new Map(); // code -> Set<send>

  const broadcast = (room, ev) => {
    const payload = JSON.stringify({ room: room.code, ...ev });
    for (const s of observers) {
      try {
        s(payload);
      } catch {
        observers.delete(s);
      }
    }
    const set = roomStreams.get(room.code);
    if (set) {
      for (const s of set) {
        try {
          s(payload);
        } catch {
          set.delete(s);
        }
      }
    }
  };

  const createRoom = ({ topic, scene, name, mp, idleEndMs, settings: s }) => {
    let code;
    do code = roomCode(); while (rooms.has(code));
    const room = new Room({
      code,
      topic: topic || '（未命名议题）',
      scene: scene ? { root: scene } : null,
      settings: { mp, idleEndMs, ...(s || {}) },
    });
    room.sceneObj = new Scene(scene);
    room.token = crypto.randomBytes(18).toString('base64url');
    room.hostToken = crypto.randomBytes(18).toString('base64url');
    room.notify = (ev) => broadcast(room, ev);
    room.onEvent = (ev) => broadcast(room, ev);
    rooms.set(code, room);
    return room;
  };

  const getRoom = (code) => rooms.get(String(code || '').toUpperCase()) || null;
  const auth = (room, req, url) => {
    const t = req.headers['x-arena-token'] || url.searchParams.get('token');
    return t && (t === room.token || t === room.hostToken);
  };
  const isHost = (room, req, url) => {
    const t = req.headers['x-arena-token'] || url.searchParams.get('token');
    return t === room.hostToken;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, x-arena-token',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }

    try {
      if (p === '/health') return json(res, 200, { ok: true, rooms: rooms.size, version: '0.1.0' });

      if (p === '/' && req.method === 'GET') {
        const page = pageHtml?.index || (typeof pageHtml === 'string' ? pageHtml : null);
        if (!page) return json(res, 200, { ok: true, hint: 'GET /r/<CODE>/state' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page);
      }

      // Observer SSE (no token: read-only public view of a room)
      if (p === '/events' && req.method === 'GET') {
        sseHeaders(res);
        // A proxy will happily buffer a small first frame until it has more
        // (cloudflared did exactly this). A padded comment forces the first
        // flush out immediately, before the hello event matters.
        res.write(`: ${' '.repeat(2048)}\n\n`);
        const send = (s) => res.write(`data: ${s}\n\n`);
        observers.add(send);
        res.write(`data: ${JSON.stringify({ hello: true, rooms: [...rooms.keys()] })}\n\n`);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          observers.delete(send);
        });
        return;
      }

      // List rooms (observer). Only the room's shape, not the spectator
      // controls — /rooms must not leak a closed room's contents.
      if (p === '/rooms' && req.method === 'GET') {
        return json(res, 200, [...rooms.values()]
          .filter((r) => r.settings.openObserver)
          .map((r) => ({ ...r.state(), createdAt: r.createdAt })));
      }

      // Open a room. Any client that can reach the hub may do this; that is
      // the point of "房主可以在任何能连上的地方开房".
      if (p === '/rooms' && req.method === 'POST') {
        const b = await body(req);
        if (b.scene) {
          try {
            await (await import('node:fs/promises')).access(b.scene);
          } catch {
            return json(res, 400, { error: `scene does not exist on the hub: ${b.scene}` });
          }
        }
        const room = createRoom(b);
        return json(res, 200, { code: room.code, token: room.token, hostToken: room.hostToken });
      }

      const m = p.match(/^\/r\/([A-Za-z0-9]+)(\/.*)?$/);
      if (!m) return json(res, 404, { error: 'not found' });
      const room = getRoom(m[1]);
      if (!room) return json(res, 404, { error: 'no such room' });
      const sub = m[2] || '/';
      const tok = url.searchParams.get('token') || req.headers['x-arena-token'];

      // Host console. The page itself is static; every action it takes is
      // host-token-gated on the server, so serving it here leaks nothing.
      // The token arrives in the fragment-friendly `?host=` query string.
      if (sub === '/control' && req.method === 'GET') {
        const page = pageHtml?.control || null;
        if (!page) return json(res, 404, { error: 'control page missing' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(page);
      }

      // Public read-only views, unless the host closed them.
      if (sub === '/state' || sub === '/') {
        if (!room.settings.openObserver && !auth(room, req, url)) {
          return json(res, 401, { error: '这个房间的实况仅对参与者开放' });
        }
        const b = await (req.method === 'POST' ? body(req) : {});
        return json(res, 200, {
          ...room.state(),
          board: room.list().map((x) => ({ key: x.key, from: x.from, version: x.version, ts: x.ts })),
          messages: b.full ? room.messages : undefined,
          conclusion: room.conclusion,
        });
      }

      if (sub === '/join' && req.method === 'POST') {
        if (!auth(room, req, url)) return json(res, 401, { error: 'bad or missing token' });
        const b = await body(req);
        const member = room.join({
          name: b.name || 'agent',
          role: b.role || 'guest',
          owner: b.owner || b.ownerName || 'anon',
          isHost: Boolean(b.isHost) && !room.hostAgentId,
          mp: Number.isFinite(b.mp) ? b.mp : undefined,
          token: tok,
        });
        if (member.refused === 'join_limit') {
          return json(res, 403, {
            error: `这个邀请最多允许 ${member.limit} 个 Agent 进场，已满。找房主要新邀请。`,
          });
        }
        return json(res, 200, {
          agentId: member.id,
          you: member,
          room: room.state(),
          etiquette: `你在房间里。没有发言顺序。循环：listen → 读消息 → pass 或 speak → listen。`,
        });
      }

      // Everything below needs a token
      const authed = auth(room, req, url);
      if (sub === '/read' || sub === '/listen') {
        if (!authed) return json(res, 401, { error: 'bad or missing token' });
        const since = Number(url.searchParams.get('since') || 0);
        const agent = url.searchParams.get('agent');
        if (sub === '/read') return json(res, 200, room.read({ sinceSeq: since, from: agent }));
        const timeout = Math.min(120000, Number(url.searchParams.get('timeout') || 60000));
        const ctrl = new AbortController();
        req.on('close', () => ctrl.abort());
        const out = await room.waitFor(since, timeout, ctrl.signal);
        if (out.finished) return json(res, 200, { ...out, state: room.state() });
        if (out.aborted) return json(res, 200, { aborted: true });
        return json(res, 200, { ...out, state: room.state(), board: room.list().map((x) => ({ key: x.key, version: x.version, from: x.from })) });
      }

      if (req.method === 'POST' && ['/speak', '/pass', '/status', '/idle', '/leave', '/board', '/scene', '/finish', '/control', '/member'].includes(sub)) {
        if (!authed) return json(res, 401, { error: 'bad or missing token' });
        const b = await body(req);
        // Removal and muting are enforced here, not just hidden in the UI.
        // Host control routes are keyed by the target id, not the caller.
        if (!['/leave', '/control', '/member'].includes(sub)) {
          const gate = room.canAct(b.agent);
          if (!gate.ok && sub !== '/pass') return json(res, 403, gate);
        }
        switch (sub) {
          case '/speak': {
            const out = room.speak({
              from: b.agent,
              text: b.text,
              basedOnSeq: b.basedOnSeq,
              force: Boolean(b.force),
              evidence: b.evidence,
            });
            if (out.ok) {
              room.touch(b.agent);
              room.notify({ type: 'message', message: out.message });
            }
            return json(res, out.ok ? 200 : 409, out);
          }
          case '/pass':
            return json(res, 200, room.pass({ from: b.agent, basedOnSeq: b.basedOnSeq }));
          case '/status':
            return json(res, 200, { ok: true, member: room.status(b.agent, b.note) });
          case '/idle':
            return json(res, 200, { ok: true, member: room.idle(b.agent) });
          case '/leave':
            room.leave(b.agent);
            return json(res, 200, { ok: true });
          case '/board': {
            const op = b.op || 'list';
            if (op === 'get') return json(res, 200, { item: room.get(b.key) });
            if (op === 'put') {
              const out = room.put({ key: b.key, value: b.value, from: b.agent, ifVersion: b.ifVersion });
              if (out.ok) room.notify({ type: 'board', item: out.item });
              return json(res, out.ok ? 200 : 409, out);
            }
            return json(res, 200, { items: room.list() });
          }
          case '/scene': {
            const sc = room.sceneObj;
            if (!sc || !sc.enabled) return json(res, 400, { error: 'this room has no scene' });
            if (!room.settings.sceneEnabled && !isHost(room, req, url)) {
              return json(res, 403, { error: '房主关闭了现场取证' });
            }
            const gate = sc.checkPolicy(room.settings, b.path || '.');
            if (!gate.ok) return json(res, 403, gate);
            const agentName = room.members.get(b.agent)?.name || 'agent';
            const op = b.op || 'list';
            let out;
            if (op === 'list') out = await sc.list(b.path || '.', { depth: b.depth ?? 1 });
            else if (op === 'read') out = await sc.read(b.path, { from: b.from, lines: b.lines });
            else if (op === 'grep') out = await sc.grep(b.pattern, { glob: b.glob, maxResults: b.max });
            else if (op === 'git') out = await sc.git(Array.isArray(b.args) ? b.args : String(b.args || '').split(' ').filter(Boolean));
            else if (op === 'logs') out = await sc.logs(b);
            else return json(res, 400, { error: `unknown scene op: ${op}` });
            room._event('scene', `${agentName} 正在现场取证：${op}`, { from: b.agent });
            return json(res, 200, out);
          }
          case '/control': {
            if (!isHost(room, req, url)) return json(res, 403, { error: '只有房主能改规则' });
            const out = room.updateSettings(b.settings || {});
            room.notify({ type: 'settings', settings: room.settings, changed: out.changed });
            return json(res, 200, { ok: true, ...out });
          }
          case '/member': {
            if (!isHost(room, req, url)) return json(res, 403, { error: '只有房主能管理选手' });
            if (b.op === 'remove') {
              const out = room.removeMember(b.id);
              if (out.ok) room.notify({ type: 'members' });
              return json(res, out.ok ? 200 : 400, out);
            }
            const out = room.setMemberControl(b.id, { disabled: b.disabled, note: b.note });
            if (out.ok) room.notify({ type: 'members' });
            return json(res, out.ok ? 200 : 400, out);
          }
          case '/finish': {
            const host = isHost(room, req, url);
            if (!host && !b.force && !room.settings.allowGuestFinish) {
              return json(res, 403, { error: '只有房主能吹哨（当前设置不允许参赛者收官）' });
            }
            if (!host && !room.settings.allowGuestFinish && b.force) {
              return json(res, 403, { error: '房主已关闭参赛者收官，force 不再有效' });
            }
            room.finish(b.reason || 'host called time', b.conclusion || null);
            room.notify({ type: 'finish', reason: b.reason });
            return json(res, 200, { ok: true, conclusion: room.conclusion });
          }
        }
      }

      if (sub === '/stream' && req.method === 'GET') {
        if (!authed) return json(res, 401, { error: 'bad or missing token' });
        const since = Number(url.searchParams.get('since') || 0);
        const finishStream = () => {
          res.write(`data: ${JSON.stringify({ type: 'finished', reason: 'room closed', conclusion: room.conclusion })}\n\n`);
          res.end();
        };
        const send = (s) => res.write(`data: ${s}\n\n`);
        sseHeaders(res);
        // Same first-flush trick as /events: the bridge can sit silent for
        // minutes and must not be held hostage by a proxy's buffer.
        res.write(`: ${' '.repeat(2048)}\n\n`);
        for (const msg of room.messages.filter((x) => x.seq > since)) res.write(`data: ${JSON.stringify({ type: 'message', message: msg })}\n\n`);
        if (!roomStreams.has(room.code)) roomStreams.set(room.code, new Set());
        roomStreams.get(room.code).add(send);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          roomStreams.get(room.code)?.delete(send);
        });
        if (room.closedAt) return finishStream();
        return;
      }

      return json(res, 404, { error: 'not found' });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  });

  server.rooms = rooms;
  server.createRoom = createRoom;
  server.closeRoom = (code) => rooms.delete(String(code).toUpperCase());
  return server;
}

/**
 * Start a hub. When `relay` is set the hub listens on localhost only and the
 * caller is responsible for exposing it (ssh -R / tunnel), which is the
 * NAT4-safe path.
 */
export async function startHub({ port = 8787, host = '0.0.0.0', pageHtml = null } = {}) {
  const server = createServer({ pageHtml });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}` };
}
