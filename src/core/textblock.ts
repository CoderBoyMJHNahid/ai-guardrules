import { detectEol, toEol } from './fsutil.js';
import { T_END, T_START } from './toml.js';

/** Managed block of plain lines with `#` comment markers (.gitignore, .gitattributes). */
export function upsertLinesBlock(existing: string | null, lines: string[]): string {
  const eol = detectEol(existing);
  const block = toEol([T_START, ...lines, T_END].join('\n'), eol);
  if (existing === null || existing.trim() === '') return block + eol;
  const s = existing.indexOf(T_START);
  const e = existing.indexOf(T_END);
  if (s !== -1 && e > s) return existing.slice(0, s) + block + existing.slice(e + T_END.length);
  return existing + (existing.endsWith('\n') ? eol : eol + eol) + block + eol;
}

export function removeLinesBlock(existing: string): string | null {
  const s = existing.indexOf(T_START);
  const e = existing.indexOf(T_END);
  if (s === -1 || e < s) return existing;
  const before = existing.slice(0, s).replace(/(\r?\n)+$/, '');
  const after = existing.slice(e + T_END.length).replace(/^(\r?\n)+/, '');
  const joined = before && after ? before + detectEol(existing) + after : before + after;
  return joined.trim() === '' ? null : joined.endsWith('\n') ? joined : joined + detectEol(existing);
}
