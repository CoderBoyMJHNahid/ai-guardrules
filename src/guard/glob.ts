export function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/** `*` matches any text (including spaces and slashes), `?` one character. */
export function wildToRegExp(pattern: string, flags = ''): RegExp {
  let re = '';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else re += escapeRe(ch);
  }
  return new RegExp('^' + re + '$', flags + 's');
}

export function matchWild(pattern: string, text: string, ci = false): boolean {
  return wildToRegExp(pattern, ci ? 'i' : '').test(text);
}

/** Convert a path glob (`*`, `**`, `?`) into a regex source (without anchors). */
function pathGlobSource(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close === -1) {
        out += '\\[';
      } else {
        let body = pattern.slice(i + 1, close);
        const neg = body.startsWith('!') || body.startsWith('^');
        if (neg) body = body.slice(1);
        out += '[' + (neg ? '^' : '') + body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]') + ']';
        i = close;
      }
    } else {
      out += escapeRe(ch);
    }
  }
  return out;
}

/** Bash-style brace expansion ({a,b}). Capped so a hostile word cannot explode. */
export function expandBraces(word: string, limit = 64): string[] {
  const out: string[] = [];
  const walk = (s: string): void => {
    if (out.length >= limit) return;
    const open = s.indexOf('{');
    if (open === -1) {
      out.push(s);
      return;
    }
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      } else if (c === ',' && depth === 1) commas.push(i);
    }
    if (close === -1 || commas.length === 0) {
      // Not an expansion: keep the brace literally and continue after it.
      const rest = s.slice(open + 1);
      const tails: string[] = [];
      const before = out.length;
      walk(rest);
      tails.push(...out.splice(before));
      for (const t of tails) out.push(s.slice(0, open + 1) + t);
      return;
    }
    const parts: string[] = [];
    let prev = open + 1;
    for (const c of commas) {
      parts.push(s.slice(prev, c));
      prev = c + 1;
    }
    parts.push(s.slice(prev, close));
    for (const p of parts) walk(s.slice(0, open) + p + s.slice(close + 1));
  };
  walk(word);
  return out;
}

const cache = new Map<string, RegExp>();

/**
 * Match a gitignore-style path glob against a posix-style relative path.
 * - A pattern without `/` matches the file name at any depth.
 * - A pattern with `/` matches the path or any trailing part of it.
 */
export function matchPathGlob(pattern: string, relPosix: string, ci = false): boolean {
  const key = (ci ? 'i:' : 's:') + pattern;
  let re = cache.get(key);
  if (!re) {
    const p = pattern.replace(/^\.\//, '');
    const flags = ci ? 'i' : '';
    if (!p.includes('/')) re = new RegExp('(?:^|/)' + pathGlobSource(p) + '$', flags);
    else re = new RegExp('(?:^|/)' + pathGlobSource(p.replace(/^\//, '')) + '$', flags);
    cache.set(key, re);
  }
  return re.test(relPosix);
}

/** Match a glob anchored at the project root (no "any depth" behaviour). */
export function matchRootGlob(pattern: string, relPosix: string, ci = false): boolean {
  const key = (ci ? 'ri:' : 'rs:') + pattern;
  let re = cache.get(key);
  if (!re) {
    re = new RegExp('^' + pathGlobSource(pattern.replace(/^\.\//, '').replace(/^\//, '')) + '$', ci ? 'i' : '');
    cache.set(key, re);
  }
  return re.test(relPosix);
}

export function hasGlobChars(s: string): boolean {
  return /[*?[]/.test(s);
}
