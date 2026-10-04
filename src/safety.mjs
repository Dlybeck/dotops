import { homedir } from 'node:os';
import { realpath, stat, lstat, opendir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PROJECTS_ROOT = path.join(homedir(), 'Projects');
export class SafeError extends Error {
  constructor(code, diagnostic) { super(code); this.code = code; if (diagnostic) this.diagnostic = diagnostic; }
}
export const fail = code => { throw new SafeError(code); };
export const inside = (root, candidate) => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);

// Same-user filesystem access, never an elevation path or a recursive filesystem inventory.
export class UserDirectoryScope {
  constructor() {
    if (process.getuid() === 0 || process.geteuid() === 0) fail('NORMAL_USER_REQUIRED');
    this.root = '/';
  }
  async directory(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) fail('OUT_OF_SCOPE');
    try {
      const canonical = await realpath(value);
      if (!(await stat(canonical)).isDirectory()) fail('OUT_OF_SCOPE');
      await access(canonical, constants.X_OK);
      return canonical;
    } catch { fail('OUT_OF_SCOPE'); }
  }
  async cwd(value) { return this.directory(value); }
  async repositories() { return new ProjectScope().repositories(); }
}

export class ProjectScope {
  constructor(root = PROJECTS_ROOT) { this.root = root; }
  async directory(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 512 ||
        /[\x00-\x1f\x7f]/.test(value) || value.split(/[\\/]/).includes('..')) fail('OUT_OF_SCOPE');
    const candidate = path.isAbsolute(value) ? value : path.resolve(this.root, value);
    if (!inside(this.root, candidate)) fail('OUT_OF_SCOPE');
    try {
      if (await realpath(this.root) !== this.root) fail('SCOPE_UNAVAILABLE');
      const canonical = await realpath(candidate);
      if (!inside(this.root, canonical) || !(await stat(canonical)).isDirectory()) fail('OUT_OF_SCOPE');
      return canonical;
    } catch (error) {
      if (error instanceof SafeError) throw error;
      fail('OUT_OF_SCOPE');
    }
  }
  async cwd(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) fail('OUT_OF_SCOPE');
    return this.directory(value);
  }
  async repositories() {
    await this.directory(this.root);
    const directory = await opendir(this.root).catch(() => fail('SCOPE_UNAVAILABLE'));
    const repos = new Map();
    let count = 0;
    for await (const entry of directory) {
      if (++count > 1000) fail('DISCOVERY_LIMIT');
      if (entry.name.startsWith('.') || !(entry.isDirectory() || entry.isSymbolicLink())) continue;
      let cwd;
      try { cwd = await this.directory(entry.name); } catch { continue; }
      // Marker metadata only: never read Git config, gitdir files, or repository content.
      const marker = await lstat(path.join(cwd, '.git')).catch(() => null);
      if (!marker || !(marker.isFile() || marker.isDirectory())) continue;
      if (await this.directory(entry.name).catch(() => null) !== cwd) continue;
      repos.set(cwd, { repository: path.relative(this.root, cwd), cwd });
    }
    await this.directory(this.root);
    return [...repos.values()].sort((a, b) => a.repository.localeCompare(b.repository));
  }
}

// Cursors are process-local, expire after 30 minutes, and cannot redirect backend reads.
export class Cursors {
  #key = randomBytes(32);
  encode(binding, position) {
    const payload = Buffer.from(JSON.stringify({ binding, position, expires: Date.now() + 1800000 })).toString('base64url');
    const mac = createHmac('sha256', this.#key).update(payload).digest('base64url');
    const token = `${payload}.${mac}`;
    if (token.length > 4096) fail('INVALID_BACKEND_RESPONSE');
    return token;
  }
  decode(token, binding) {
    if (!token) return null;
    try {
      if (typeof token !== 'string' || token.length > 4096) fail('INVALID_CURSOR');
      const parts = token.split('.');
      if (parts.length !== 2) fail('INVALID_CURSOR');
      const mac = Buffer.from(parts[1], 'base64url');
      const expected = createHmac('sha256', this.#key).update(parts[0]).digest();
      if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) fail('INVALID_CURSOR');
      const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      if (decoded.binding !== binding || !Number.isFinite(decoded.expires) || decoded.expires < Date.now()) fail('INVALID_CURSOR');
      return decoded.position;
    } catch { fail('INVALID_CURSOR'); }
  }
}

// Defense in depth for transcript text; arbitrary unlabeled secrets are not detectable.
export function safeText(value, limit) {
  if (typeof value !== 'string') return { text: '', truncated: false, redacted: false };
  let text = value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  const original = text;
  text = text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|authorization|token)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]');
  return { text: text.slice(0, limit), truncated: text.length > limit, redacted: text !== original };
}
