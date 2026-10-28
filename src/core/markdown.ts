import { detectEol, toEol } from './fsutil.js';

export const START = '<!-- ai-guardrules:start -->';
export const END = '<!-- ai-guardrules:end -->';

export class MarkerError extends Error {}

function findBlock(text: string): { start: number; end: number } | null {
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s === -1 && e === -1) return null;
  if (s === -1 || e === -1 || e < s) throw new MarkerError('found an incomplete ai-guardrules marker block');
  if (text.indexOf(START, s + START.length) !== -1) throw new MarkerError('found more than one ai-guardrules marker block');
  return { start: s, end: e + END.length };
}

export function hasBlock(text: string | null): boolean {
  return text !== null && text.includes(START) && text.includes(END);
}

export function renderBlock(body: string): string {
  return `${START}\n${body.trim()}\n${END}`;
}

/** Insert or replace the managed block, keeping everything else byte-for-byte (including line endings). */
export function upsertBlock(existing: string | null, body: string, header = ''): string {
  const eol = detectEol(existing);
  const block = toEol(renderBlock(body), eol);
  if (existing === null || existing.trim() === '') return toEol(header + block + '\n', eol);
  const found = findBlock(existing);
  if (found) return existing.slice(0, found.start) + block + existing.slice(found.end);
  const sep = existing.endsWith('\n') ? eol : eol + eol;
  return existing + sep + block + eol;
}

/** Remove the managed block. Returns null when nothing meaningful is left. */
export function removeBlock(existing: string, header = ''): string | null {
  const found = findBlock(existing);
  if (!found) return existing;
  let before = existing.slice(0, found.start);
  let after = existing.slice(found.end);
  before = before.replace(/(\r?\n){2,}$/, (m) => (m.includes('\r') ? '\r\n' : '\n'));
  after = after.replace(/^(\r?\n)+/, '');
  const joined = before + after;
  const rest = joined.trim();
  if (rest === '' || rest === header.trim()) return null;
  return joined.endsWith('\n') ? joined : joined + detectEol(existing);
}
