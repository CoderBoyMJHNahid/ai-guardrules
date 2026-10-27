import { detectEol, toEol } from './fsutil.js';

export const T_START = '# ai-rules:start';
export const T_END = '# ai-rules:end';

function find(text: string): { start: number; end: number } | null {
  const s = text.indexOf(T_START);
  const e = text.indexOf(T_END);
  if (s === -1 && e === -1) return null;
  if (s === -1 || e === -1 || e < s) throw new Error('found an incomplete ai-rules block in a TOML file');
  return { start: s, end: e + T_END.length };
}

function topLevelKeys(text: string, skip: { start: number; end: number } | null): Set<string> {
  const keys = new Set<string>();
  const scan = skip ? text.slice(0, skip.start) + text.slice(skip.end) : text;
  for (const line of scan.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(line);
    if (m) keys.add(m[1] as string);
  }
  return keys;
}

/**
 * Put top-level `key = value` lines in a managed block at the top of the file.
 * Keys the user already set are left alone and reported in `skipped`.
 */
export function upsertTomlBlock(existing: string | null, entries: Array<[string, string]>): { text: string; skipped: string[] } {
  const eol = detectEol(existing);
  const base = existing ?? '';
  const found = find(base);
  const taken = topLevelKeys(base, found);
  const skipped: string[] = [];
  const lines: string[] = [];
  for (const [k, v] of entries) {
    if (taken.has(k)) skipped.push(k);
    else lines.push(`${k} = ${v}`);
  }
  const without = found ? (base.slice(0, found.start) + base.slice(found.end)).replace(/^(\r?\n)+/, '') : base;
  if (lines.length === 0) return { text: without, skipped };
  const block = toEol([T_START, ...lines, T_END].join('\n'), eol);
  return { text: block + eol + (without === '' ? '' : eol + without), skipped };
}

export function removeTomlBlock(existing: string): string | null {
  const found = find(existing);
  if (!found) return existing;
  const rest = (existing.slice(0, found.start) + existing.slice(found.end)).replace(/^(\r?\n)+/, '');
  return rest.trim() === '' ? null : rest;
}

export function hasTomlBlock(text: string | null): boolean {
  return text !== null && text.includes(T_START) && text.includes(T_END);
}
