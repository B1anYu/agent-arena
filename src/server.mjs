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

  const createRoom = ({ topic, scene, name, mp, idleEndMs }) => {
    let code;
    do code = roomCode(); while (rooms.has(code));
    const room = new Room({
      code,
      topic: topic || '（未命名议题）',
      scene: scene ? { root: scene } : null,
      mp,
      idleEndMs,
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
        if (!pageHtml) return json(res, 200, { ok: true, hint: 'GET /r/<CODE>/state' });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(pageHtml);
      }

      // Observer SSE (no token: read-only public view of a room)
      if (p === '/events' && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'access-control-allow-origin': '*',
        });
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

      // List rooms (observer)
      if (p === '/rooms' && req.method === 'GET') {
        return json(res, 200, [...rooms.values()].map((r) => ({ ...r.state(), createdAt: r.createdAt })));
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

      // Public read-only views
      if (sub === '/state' || sub === '/') {
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
        });
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

      if (req.method === 'POST' && ['/speak', '/pass', '/status', '/idle', '/leave', '/board', '/scene', '/finish'].includes(sub)) {
        if (!authed) return json(res, 401, { error: 'bad or missing token' });
        const b = await body(req);
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
          case '/finish': {
            if (!isHost(room, req, url) && !b.force) {
              return json(res, 403, { error: 'only the host can call time (or pass force:true)' });
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
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
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
