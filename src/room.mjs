/**
 * In-memory room state: members, the append-only message stream (#1, #2, ...),
 * the debounce window, the blackboard and the referee.
 *
 * All multiplayer rules live here so the HTTP layer stays a thin shell.
 */

export const DEFAULT_MP = 8;
export const DEBOUNCE_MS = 1500;
export const IDLE_END_MS = 10000;
export const INTERRUPTED_KEEP_MS = 4000;

const now = () => Date.now();
const rand = (n) => Math.floor(Math.random() * n);

const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function roomCode(len = 4) {
  let s = '';
  for (let i = 0; i < len; i++) s += ID_ALPHABET[rand(ID_ALPHABET.length)];
  return s;
}
export function agentId(name) {
  const slug = String(name || 'agent')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24) || 'agent';
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Debounce aggregation: messages that arrive within DEBOUNCE_MS of the first
 * pending one go into one batch, so an agent woken at the end of the window
 * sees the whole exchange instead of four half-sentencess.
 */
export class Room {
  constructor({ code, topic, scene = null, mp = DEFAULT_MP, idleEndMs = IDLE_END_MS }) {
    this.code = code;
    this.topic = topic;
    this.scene = scene;
    this.hostAgentId = null;
    this.mp = mp;
    this.idleEndMs = idleEndMs;
    this.createdAt = now();
    this.closedAt = null;
    this.onEvent = null;

    this.members = new Map(); // agentId -> member
    this.messages = []; // {seq, from, fromName, role, kind, text, evidence, ts, interrupted?}
    this.seq = 0;
    this.board = new Map(); // key -> {key, value, from, ts, version}
    this.log = []; // system events for the observer page: joins, leaves, status
    this.batch = null; // {fromSeq, toSeq, timer}
    this.conclusion = null;
    this._waiters = new Set();
  }

  _add({ name, role, owner, isHost = false, mp }) {
    const id = agentId(name);
    const member = {
      id,
      name: name || id,
      role: role || 'guest',
      owner: owner || 'anon',
      isHost,
      mp: mp ?? this.mp,
      status: 'idle', // idle | working | waiting | offline
      note: null,
      joinedAt: now(),
      lastSeen: now(),
      lastSpoke: 0,
    };
    this.members.set(id, member);
    if (isHost) this.hostAgentId = id;
    this._event('join', `${member.name}（${member.role}）入场`);
    return member;
  }

  _event(kind, text, extra = {}) {
    const e = { type: 'event', kind, text, ts: now(), ...extra };
    this.log.push(e);
    if (this.onEvent) this.onEvent(e);
    return e;
  }

  join({ name, role, owner, mp, isHost = false }) {
    // Re-entry with the same name is allowed; ids are unique per join.
    return this._add({ name, role, owner, isHost, mp });
  }

  leave(id) {
    const m = this.members.get(id);
    if (!m) return false;
    m.status = 'offline';
    m.lastSeen = now();
    this._event('leave', `${m.name} 离场`);
    return true;
  }

  touch(id) {
    const m = this.members.get(id);
    if (!m) return null;
    m.lastSeen = now();
    if (m.status === 'offline') m.status = 'idle';
    return m;
  }

  status(id, note) {
    const m = this.members.get(id);
    if (!m) return null;
    m.status = 'working';
    m.note = String(note || '').slice(0, 280);
    this._event('status', `${m.name}：${m.note || '正在取证…'}`, { from: id });
    return m;
  }

  idle(id) {
    const m = this.members.get(id);
    if (!m) return null;
    m.status = 'idle';
    m.note = null;
    return m;
  }

  currentSeq() {
    return this.seq;
  }

  message(sinceSeq = 0, { fromExclude = null } = {}) {
    return this.messages.filter((m) => m.seq > sinceSeq && m.from !== fromExclude);
  }

  /**
   * Speak. The optimistic lock: the caller states the last seq it saw.
   * If anyone said something while this agent was typing, the server does
   * not publish the message. It returns the new message plus a note, and the
   * agent decides: revise, fold in, or force it out with force=true.
   */
  speak({ from, text, basedOnSeq, force = false, evidence = null, kind = 'text' }) {
    const m = this.members.get(from);
    if (!m) return { ok: false, error: `unknown agent ${from}` };
    if (this.closedAt) return { ok: false, error: 'room is closed' };
    const body = String(text || '').trim();
    if (!body) return { ok: false, error: 'empty message' };

    const based = Number.isInteger(basedOnSeq) ? basedOnSeq : this.seq;
    if (!force && based < this.seq) {
      const missed = this.messages.filter((x) => x.seq > based);
      return {
        ok: false,
        interrupted: true,
        currentSeq: this.seq,
        missed,
        hint: `在你打字期间房间新增了 ${missed.length} 条消息（#${missed[0].seq}–#${missed[missed.length - 1].seq}）。先读 missed，再决定：合并后重发，或 force=true 原样发出。`,
      };
    }

    // Energy: plain opinion costs 1 MP; evidence counters do not.
    const hasEvidence = Boolean(evidence && String(evidence).trim());
    if (!hasEvidence) {
      if (m.mp <= 0) {
        return {
          ok: false,
          exhausted: true,
          hint: '你的精力条已耗尽。要么下场取证（带 evidence 发言不扣精力），要么 pass。',
        };
      }
      m.mp -= 1;
    } else {
      m.mp = Math.min(this.mp, m.mp + 1); // evidence refunds at most 1
    }

    this.seq += 1;
    const msg = {
      seq: this.seq,
      from,
      fromName: m.name,
      role: m.role,
      kind,
      text: body,
      evidence: hasEvidence ? String(evidence).slice(0, 4000) : null,
      ts: now(),
    };
    this.messages.push(msg);
    m.status = 'idle';
    m.note = null; // the agent spoke; the "正在查…" sign comes down
    m.lastSpoke = msg.ts;
    m.lastSeen = msg.ts;
    this._scheduleBatch(msg);
    return { ok: true, message: msg, mp: m.mp };
  }

  /**
   * Passing costs nothing but is visible: it tells the referee someone saw
   * the latest exchange and chose silence.
   */
  pass({ from, basedOnSeq }) {
    const m = this.members.get(from);
    if (!m) return { ok: false, error: `unknown agent ${from}` };
    m.status = 'idle';
    m.lastSeen = now();
    m.passes = (m.passes || 0) + 1;
    m.note = null;
    m.lastPass = { seq: Number.isInteger(basedOnSeq) ? basedOnSeq : this.seq, ts: now() };
    this._event('pass', `${m.name} 选择潜水，继续吃瓜`, { from });
    this._maybeFinishIdle();
    return { ok: true, mp: m.mp };
  }

  /**
   * Poll-side read: returns everything after sinceSeq, plus the debounce
   * indication (batch still open) so the client knows more may follow.
   */
  read({ sinceSeq = 0, from }) {
    const m = from ? this.members.get(from) : null;
    if (m) m.lastSeen = now();
    const batchOpen = Boolean(this.batch) && this.batch.fromSeq <= this.seq;
    return {
      messages: this.messages.filter((x) => x.seq > sinceSeq),
      seq: this.seq,
      state: this.state(),
      batchOpen,
      batchEndsAt: batchOpen ? this.batch.endsAt : 0,
    };
  }

  /** Long-poll: resolve as soon as seq moves past sinceSeq, or on timeout. */
  waitFor(sinceSeq, timeoutMs, signal) {
    // Someone who arrives after the whistle should learn it's over, not be
    // handed a backlog that looks like the argument is still going.
    if (this.closedAt) {
      return Promise.resolve({ finished: true, reason: '房间已收官', conclusion: this.conclusion, seq: this.seq });
    }
    return new Promise((resolve) => {
      let done = false;
      const waiter = {};
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        clearTimeout(d);
        this._waiters.delete(waiter);
        resolve(v);
      };
      const t = setTimeout(() => finish({ timeout: true }), Math.max(0, timeoutMs));
      // Respect the debounce window: a lone message is still delivered, but
      // if a batch is open we hold until it closes so the caller gets the
      // whole exchange at once.
      let d = null;
      const check = () => {
        if (done || this.seq <= sinceSeq) return;
        if (this.batch) {
          clearTimeout(d);
          d = setTimeout(() => {
            check.fired = true;
            finish({ messages: this.messages.filter((x) => x.seq > sinceSeq), seq: this.seq });
          }, Math.max(0, this.batch.endsAt - now()));
          return;
        }
        finish({ messages: this.messages.filter((x) => x.seq > sinceSeq), seq: this.seq });
      };
      waiter.check = check;
      waiter.finish = finish;
      this._waiters.add(waiter);
      if (signal) signal.addEventListener('abort', () => finish({ aborted: true }), { once: true });
      check();
    });
  }

  _scheduleBatch(msg) {
    if (!this.batch) {
      this.batch = { fromSeq: msg.seq, toSeq: msg.seq, endsAt: now() + DEBOUNCE_MS };
      setTimeout(() => {
        const b = this.batch;
        this.batch = null;
        for (const w of this._waiters) w.check();
        if (b) this._maybeFinishIdle();
      }, DEBOUNCE_MS);
    } else {
      this.batch.toSeq = msg.seq;
      this.batch.endsAt = now() + DEBOUNCE_MS;
    }
    this._maybeFinishIdle();
  }

  /**
   * Referee: if the stream has been quiet for idleEndMs and nobody is
   * working, call time. The host can always finish by hand.
   */
  _maybeFinishIdle() {
    if (this.closedAt) return;
    clearTimeout(this._idleTimer);
    if (this.messages.length === 0) return;
    const busy = [...this.members.values()].some((m) => m.status === 'working');
    if (busy) return;
    const sinceLast = now() - (this.messages[this.messages.length - 1]?.ts || 0);
    const wait = Math.max(0, this.idleEndMs - sinceLast);
    this._idleTimer = setTimeout(() => {
      if (this.closedAt) return;
      const stillBusy = [...this.members.values()].some((m) => m.status === 'working');
      if (stillBusy) return this._maybeFinishIdle();
      this.finish('一个来回内无人再开麦，裁判吹哨');
    }, wait);
  }

  finish(reason = 'host called time', conclusion = null) {
    if (this.closedAt) return this.conclusion;
    this.closedAt = now();
    clearTimeout(this._idleTimer);
    if (conclusion) this.conclusion = String(conclusion);
    this._event('finish', `房间收官：${reason}`);
    for (const w of this._waiters) w.finish({ finished: true, reason, conclusion: this.conclusion });
    return this.conclusion;
  }

  state() {
    return {
      code: this.code,
      topic: this.topic,
      scene: this.scene,
      seq: this.seq,
      closed: Boolean(this.closedAt),
      members: [...this.members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        role: m.role,
        owner: m.owner,
        isHost: m.isHost,
        mp: m.mp,
        status: m.status,
        note: m.note,
        online: m.status !== 'offline',
      })),
    };
  }

  /** Unread summary for a given agent, used in status output. */
  unreadFor(from, sinceSeq) {
    return this.messages.filter((m) => m.seq > sinceSeq && m.from !== from).length;
  }

  get(key) {
    return this.board.get(key) || null;
  }
  put({ key, value, from, ifVersion }) {
    const prev = this.board.get(key);
    if (ifVersion != null && prev && prev.version !== ifVersion) {
      return { ok: false, conflict: true, current: prev };
    }
    const version = (prev?.version || 0) + 1;
    const item = { key, value: String(value ?? ''), from, ts: now(), version };
    this.board.set(key, item);
    return { ok: true, item };
  }
  list() {
    return [...this.board.values()];
  }
}
