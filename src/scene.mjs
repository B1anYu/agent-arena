/**
 * Read-only forensic scene: everything a guest agent may look at, and nothing
 * else. Paths are locked inside the scene root, symlinks are resolved before
 * the containment check, and key material is blocked by name and content.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const SECRET_PATTERNS = [
  /^\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^credentials/i,
  /^\.ssh$/i,
  /^\.aws$/i,
  /^\.gnupg$/i,
];

const SECRET_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(?:api[_-]?key|secret|password|token|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}/i,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{20,}/,
];

export function isSecretName(name) {
  return SECRET_PATTERNS.some((re) => re.test(name));
}

export function looksLikeSecret(text) {
  return SECRET_CONTENT.some((re) => re.test(text));
}

export class Scene {
  constructor(root, { maxBytes = 200_000 } = {}) {
    this.root = root ? path.resolve(root) : null;
    this.maxBytes = maxBytes;
  }

  get enabled() {
    return Boolean(this.root);
  }

  /** Resolve a caller-supplied path and refuse anything outside the root. */
  async resolve(p, { allowRoot = true } = {}) {
    if (!this.enabled) throw new Error('this room has no scene');
    const raw = String(p || '.');
    const abs = path.resolve(this.root, raw.replace(/^\/+/, ''));
    let real;
    try {
      real = await fs.realpath(abs);
    } catch {
      throw new Error(`path not found: ${raw}`);
    }
    const rootReal = await fs.realpath(this.root);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
      throw new Error(`path escapes the scene root: ${raw}`);
    }
    if (!allowRoot && real === rootReal) throw new Error('path must be inside the scene, not the root');
    return { abs: real, rel: path.relative(rootReal, real) || '.' };
  }

  async stat(p) {
    const { abs, rel } = await this.resolve(p);
    const st = await fs.stat(abs);
    return { abs, rel, ...st };
  }

  async list(p, { depth = 1 } = {}) {
    const { abs, rel } = await this.resolve(p);
    const st = await fs.stat(abs);
    if (!st.isDirectory()) return { rel, files: [rel] };
    const files = [];
    const walk = async (dir, level, prefix) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (isSecretName(e.name) || e.name === '.git') continue;
        const childRel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) {
          files.push(`${childRel}/`);
          if (depth === 0 || level < depth) await walk(path.join(dir, e.name), level + 1, childRel);
        } else {
          files.push(childRel);
        }
      }
    };
    await walk(abs, 1, rel === '.' ? '' : rel);
    return { rel, files };
  }

  async read(p, { from = 1, lines = 120 } = {}) {
    const { abs, rel } = await this.resolve(p, { allowRoot: false });
    if (isSecretName(path.basename(abs))) throw new Error(`refused: ${path.basename(abs)} looks like key material`);
    const st = await fs.stat(abs);
    if (st.isDirectory()) throw new Error('that is a directory; use scene_list');
    if (st.size > this.maxBytes) throw new Error(`file too large (${st.size} bytes); use scene_grep or read a smaller range`);
    const buf = await fs.readFile(abs);
    if (buf.includes(0)) throw new Error('binary file; not readable through the scene');
    const text = buf.toString('utf8');
    if (looksLikeSecret(text)) throw new Error('refused: file content looks like credentials');
    const all = text.split('\n');
    const slice = all.slice(Math.max(0, from - 1), Math.max(0, from - 1) + lines);
    return { rel, total_lines: all.length, from, lines: slice };
  }

  async grep(pattern, { glob = null, maxResults = 200 } = {}) {
    if (!this.enabled) throw new Error('this room has no scene');
    const { abs } = await this.resolve('.');
    if (!pattern) throw new Error('pattern is required');
    const re = new RegExp(pattern, 'i');
    const results = [];
    const walk = async (dir) => {
      if (results.length >= maxResults) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (results.length >= maxResults) return;
        if (isSecretName(e.name) || e.name === '.git' || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
          continue;
        }
        if (glob && !e.name.includes(glob.replace(/\*/g, ''))) continue;
        const st = await fs.stat(full).catch(() => null);
        if (!st || st.size > this.maxBytes) continue;
        const buf = await fs.readFile(full).catch(() => null);
        if (!buf || buf.includes(0)) continue;
        const text = buf.toString('utf8');
        if (looksLikeSecret(text)) continue;
        text.split('\n').forEach((line, i) => {
          if (results.length < maxResults && re.test(line)) {
            results.push({ file: path.relative(this.root, full), line: i + 1, text: line.slice(0, 500) });
          }
        });
      }
    };
    await walk(abs);
    return { pattern, results, truncated: results.length >= maxResults };
  }

  async git(args, { max = 8000 } = {}) {
    if (!this.enabled) throw new Error('this room has no scene');
    const { spawn } = await import('node:child_process');
    const safe = ['log', 'blame', 'diff', 'show', 'status', 'branch', 'shortlog'];
    const sub = String(args[0] || '');
    if (!safe.includes(sub)) throw new Error(`only read-only git subcommands are allowed: ${safe.join(', ')}`);
    const clean = args.filter((a) => typeof a === 'string' && !a.startsWith('--output'));
    return new Promise((resolve, reject) => {
      const p = spawn('git', clean, { cwd: this.root, timeout: 20_000 });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => {
        if (out.length < max) out += d.toString();
      });
      p.stderr.on('data', (d) => {
        if (err.length < max) err += d.toString();
      });
      p.on('error', reject);
      p.on('close', (code) => resolve({ out: out.slice(0, max), err: err.slice(0, max), code }));
    });
  }

  async logs({ file = null, lines = 100, pattern = null } = {}) {
    if (!this.enabled) throw new Error('this room has no scene');
    const candidates = file
      ? [file]
      : (await this.list('.', { depth: 2 })).files
          .filter((f) => !f.endsWith('/') && /log|error|access|trace|stderr|stdout/i.test(f))
          .slice(0, 20);
    if (!candidates.length) return { files: [], note: 'no obvious log files; pass file= explicitly' };
    const out = [];
    for (const c of candidates) {
      try {
        const r = await this.read(c, { lines });
        let text = r.lines.join('\n');
        if (pattern) text = text.split('\n').filter((l) => new RegExp(pattern, 'i').test(l)).join('\n');
        out.push({ file: c, tail: text });
      } catch (e) {
        out.push({ file: c, error: e.message });
      }
    }
    return { files: out };
  }
}
