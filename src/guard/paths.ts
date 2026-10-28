import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Path handling with injectable platform semantics, so Windows rules can be
 * unit-tested on any OS (pass `path.win32` and a fake filesystem).
 */
export interface PathEnv {
  api: typeof path.posix;
  platform: 'win32' | 'posix';
  caseInsensitive: boolean;
  home: string;
  realpath: (p: string) => string;
  exists: (p: string) => boolean;
  isSymlink: (p: string) => boolean;
  isFile: (p: string) => boolean;
  isDir: (p: string) => boolean;
  /** Environment variables used to resolve `$VAR` / `%VAR%` in paths. */
  vars: Record<string, string>;
}

/**
 * Canonical form of an existing path. Uses the native realpath so Windows 8.3 short
 * names (RUNNER~1) are expanded. The project root and every resolved path must go
 * through this same function, or `isInside` compares short names to long names.
 */
export function canonicalPath(p: string): string {
  return (fs.realpathSync.native ?? fs.realpathSync)(p);
}

export function defaultEnv(root?: string): PathEnv {
  const win = process.platform === 'win32';
  const home = os.homedir();
  const vars: Record<string, string> = { HOME: home, USERPROFILE: home };
  if (root) {
    vars.CLAUDE_PROJECT_DIR = root;
    vars.CURSOR_PROJECT_DIR = root;
    vars.GEMINI_PROJECT_DIR = root;
    vars.PROJECT_DIR = root;
  }
  return {
    api: (win ? path.win32 : path.posix) as typeof path.posix,
    platform: win ? 'win32' : 'posix',
    caseInsensitive: win || process.platform === 'darwin',
    home,
    realpath: canonicalPath,
    exists: (p) => fs.existsSync(p),
    isSymlink: (p) => {
      try {
        return fs.lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    },
    isFile: (p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    },
    isDir: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    vars,
  };
}

export type Resolved = { ok: true; abs: string } | { ok: false; reason: string };

const WIN_DEVICE = /^(con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;

/** True for tokens that mean "discard output" and never touch the disk. */
export function isNullDevice(token: string): boolean {
  return token === '/dev/null' || /^nul$/i.test(token) || token === '$null';
}

function substituteVars(token: string, env: PathEnv): { text: string; unresolved: boolean } {
  let unresolved = false;
  let text = token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const name = (a ?? b) as string;
    const v = env.vars[name];
    if (v === undefined) {
      unresolved = true;
      return m;
    }
    return v;
  });
  text = text.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (m, name: string) => {
    const v = env.vars[name] ?? env.vars[name.toUpperCase()];
    if (v === undefined) {
      unresolved = true;
      return m;
    }
    return v;
  });
  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => {
    const v = env.vars[name] ?? env.vars[name.toUpperCase()];
    if (v === undefined) {
      unresolved = true;
      return m;
    }
    return v;
  });
  if (/[`]|\$\(|\$[0-9@*?#!$-]/.test(text)) unresolved = true;
  return { text, unresolved };
}

/** `file::$DATA` and `file:stream:$DATA` name the same file on NTFS. */
export function stripStreamSuffix(token: string): string {
  return token.replace(/(:[^\\/:]*)?::\$[A-Za-z_]+$/i, '').replace(/:\$[A-Za-z_]+$/i, '');
}

function normalizeWindows(token: string): string | null {
  let t = token;
  if (/^\\\\\.\\/.test(t) || /^\/\/\.\//.test(t)) return null; // device namespace
  if (/^\\\\\?\\/.test(t) || /^\/\/\?\//.test(t)) t = t.slice(4); // long path prefix
  if (/^UNC[\\/]/i.test(t)) t = '\\\\' + t.slice(4);
  // Alternate data streams: file.txt:stream -> file.txt (but keep drive letters).
  const drive = /^[A-Za-z]:/.test(t) ? t.slice(0, 2) : '';
  let rest = drive ? t.slice(2) : t;
  const colon = rest.indexOf(':');
  if (colon >= 0) rest = rest.slice(0, colon);
  t = drive + rest;
  const parts = t.split(/[\\/]/);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '' || part === '.' || part === '..') continue;
    const trimmed = part.replace(/[. ]+$/, '');
    parts[i] = trimmed === '' ? part : trimmed;
    const base = (parts[i] as string).split('.')[0] as string;
    if (WIN_DEVICE.test(base) && i === parts.length - 1) return null;
  }
  return parts.join('\\');
}

/** Expand `~`, known variables and relative segments, then follow symlinks. */
export function resolvePath(token: string, cwd: string, env: PathEnv): Resolved {
  if (token === '') return { ok: false, reason: 'empty path' };
  let t = token;
  if (env.platform === 'win32') t = stripStreamSuffix(t);
  const sub = substituteVars(t, env);
  if (sub.unresolved) return { ok: false, reason: `path with unresolved variable: ${token}` };
  t = sub.text;
  if (t === '~' || /^~[\\/]/.test(t)) t = env.home + t.slice(1);
  else if (/^~[^\\/]/.test(t)) return { ok: false, reason: `path with user home expansion: ${token}` };
  if (env.platform === 'win32') {
    const n = normalizeWindows(t);
    if (n === null) return { ok: false, reason: `device path: ${token}` };
    t = n;
  }
  let abs = env.api.resolve(cwd, t);
  // Follow symlinks on the nearest existing ancestor so a link cannot smuggle a path out.
  try {
    let cur = abs;
    const rest: string[] = [];
    while (!env.exists(cur)) {
      const parent = env.api.dirname(cur);
      if (parent === cur) break;
      rest.unshift(env.api.basename(cur));
      cur = parent;
    }
    if (env.exists(cur)) {
      const real = env.realpath(cur);
      abs = rest.length ? env.api.join(real, ...rest) : real;
    }
  } catch {
    /* keep abs */
  }
  return { ok: true, abs };
}

export function normCase(p: string, env: PathEnv): string {
  return env.caseInsensitive ? p.toLowerCase() : p;
}

export function isInside(root: string, target: string, env: PathEnv): boolean {
  const r = normCase(root, env);
  const t = normCase(target, env);
  const rel = env.api.relative(r, t);
  if (rel === '') return true;
  if (rel === '..' || rel.startsWith('..' + env.api.sep) || rel.startsWith('../')) return false;
  if (env.api.isAbsolute(rel)) return false;
  return true;
}

/** Posix-style path relative to root, for glob matching. */
export function relPosix(root: string, target: string, env: PathEnv): string {
  const rel = env.api.relative(root, target);
  return rel.split(/[\\/]/).join('/');
}

export function samePath(a: string, b: string, env: PathEnv): boolean {
  return normCase(env.api.resolve(a), env) === normCase(env.api.resolve(b), env);
}
