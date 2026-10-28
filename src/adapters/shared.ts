import path from 'node:path';
import { detectEol, readText } from '../core/fsutil.js';
import { getPath, newJson, parseJsonc, setPath } from '../core/json.js';
import { hasBlock, removeBlock, upsertBlock } from '../core/markdown.js';
import type { Change } from './types.js';

export const GUARD_REL = '.ai-guardrules/guard.mjs';
export const MARK = GUARD_REL;

export function guardCommand(tool: string): string {
  return `node ${GUARD_REL} --tool=${tool}`;
}

export function guardArgs(tool: string): string[] {
  return [GUARD_REL, `--tool=${tool}`];
}

export function isOurs(x: unknown): boolean {
  try {
    return JSON.stringify(x).includes(MARK);
  } catch {
    return false;
  }
}

export function abs(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

export function change(root: string, rel: string, after: string | null, note: string): Change | null {
  const before = readText(abs(root, rel));
  if (before === after) return null;
  return { file: rel, before, after, note };
}

/** Markdown file with a managed block. `header` is written only when the file is created (e.g. front matter). */
export function mdInstall(root: string, rel: string, body: string, note: string, header = ''): Change | null {
  const before = readText(abs(root, rel));
  return change(root, rel, upsertBlock(before, body, header), note);
}

export function mdRemove(root: string, rel: string, note: string, header = ''): Change | null {
  const before = readText(abs(root, rel));
  if (before === null || !hasBlock(before)) return null;
  return { file: rel, before, after: removeBlock(before, header), note };
}

export function mdHasBlock(root: string, rel: string): boolean {
  return hasBlock(readText(abs(root, rel)));
}

/** Small helper for editing JSON files while preserving formatting and comments. */
export class JsonEditor {
  text: string;
  readonly original: string | null;
  constructor(
    original: string | null,
    readonly file: string,
  ) {
    this.original = original;
    this.text = original ?? '{}' + '\n';
    this.doc();
  }
  doc(): unknown {
    return parseJsonc(this.text, this.file);
  }
  get(p: (string | number)[]): unknown {
    return getPath(this.doc(), p);
  }
  set(p: (string | number)[], value: unknown): void {
    this.text = setPath(this.text, p, value);
  }
  /** Delete empty arrays and objects from `p` upward. */
  prune(p: (string | number)[]): void {
    const cur = [...p];
    while (cur.length) {
      const v = this.get(cur);
      const empty = (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0);
      if (!empty) return;
      this.set(cur, undefined);
      cur.pop();
    }
  }
  isEmptyObject(): boolean {
    const d = this.doc();
    return typeof d === 'object' && d !== null && !Array.isArray(d) && Object.keys(d).length === 0;
  }
  /** Final text; an empty file we would otherwise leave behind becomes null. */
  result(): string | null {
    return this.isEmptyObject() && this.original === null ? null : this.text;
  }
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Put our entry first and drop any older copy of it. */
export function withOurs(existing: unknown, entry: unknown): unknown[] {
  return [entry, ...asArray(existing).filter((e) => !isOurs(e))];
}

export function withoutOurs(existing: unknown): unknown[] {
  return asArray(existing).filter((e) => !isOurs(e));
}

export function addUnique(existing: unknown, wanted: string[]): string[] {
  const cur = asArray(existing).filter((x): x is string => typeof x === 'string');
  const out = [...cur];
  for (const w of wanted) if (!out.includes(w)) out.push(w);
  return out;
}

export function removeKnown(existing: unknown, known: string[]): string[] {
  return asArray(existing).filter((x): x is string => typeof x === 'string' && !known.includes(x));
}

export { detectEol, newJson, readText };
