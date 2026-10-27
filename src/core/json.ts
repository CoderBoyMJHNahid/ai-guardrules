import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { detectEol } from './fsutil.js';

export class JsonError extends Error {}

/** Parse JSON with comments. Throws a readable error so we never overwrite a file we cannot read. */
export function parseJsonc<T = unknown>(text: string, file: string): T {
  const errors: ParseError[] = [];
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) as T;
  if (errors.length) {
    const e = errors[0] as ParseError;
    throw new JsonError(`${file} is not valid JSON (${printParseErrorCode(e.error)} at offset ${e.offset}). Fix it or move it aside, then run again.`);
  }
  return value;
}

function indentOf(text: string): { insertSpaces: boolean; tabSize: number } {
  const m = /\n([ \t]+)"/.exec(text);
  if (m && (m[1] as string).startsWith('\t')) return { insertSpaces: false, tabSize: 1 };
  return { insertSpaces: true, tabSize: m ? (m[1] as string).length : 2 };
}

/** Set (or with `undefined`, delete) a value, preserving comments, indentation and line endings. */
export function setPath(text: string, jsonPath: (string | number)[], value: unknown): string {
  const eol = detectEol(text);
  const edits = modify(text, jsonPath, value, { formattingOptions: { ...indentOf(text), eol } });
  return applyEdits(text, edits);
}

export function getPath(root: unknown, jsonPath: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const k of jsonPath) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

export function newJson(value: unknown, eol: '\n' | '\r\n' = '\n'): string {
  return JSON.stringify(value, null, 2).replace(/\n/g, eol) + eol;
}
