import type { Dialect } from '../types.js';

export interface Word {
  value: string;
  raw: string;
  /** Contains something that could not be resolved statically ($VAR, $(...), brace expansion). */
  dynamic: boolean;
  /** Contains an unquoted glob character. */
  glob: boolean;
  quoted: boolean;
}

export interface Redirect {
  op: string;
  target: Word | null;
}

export interface EnvAssign {
  name: string;
  value: Word;
}

/** A command exactly as it appears in the source, before wrapper unwrapping. */
export interface RawCommand {
  words: Word[];
  env: EnvAssign[];
  redirects: Redirect[];
  heredocs: string[];
  pipedFrom: RawCommand | null;
  src: string;
}

export interface Unresolved {
  reason: string;
  detail: string;
  /** `deny` reasons are blocked by the `unparseable` guard; `ask` reasons are informational. */
  severity: 'deny' | 'ask';
}

export interface InlineCode {
  lang: string;
  code: string;
}

/** A command after wrappers (sudo, env, sh -c, xargs, ...) were removed. */
export interface SimpleCommand {
  /** Canonical lowercase name without path or extension. */
  name: string;
  rawName: string;
  args: Word[];
  env: EnvAssign[];
  redirects: Redirect[];
  heredocs: string[];
  /** Wrappers this command was found under, outermost first. */
  via: string[];
  dialect: Dialect;
  inline: InlineCode[];
  pipedFrom: SimpleCommand | null;
  /** Arguments also come from stdin (xargs, parallel). */
  stdinArgs: boolean;
  src: string;
}

export interface ParseResult {
  commands: SimpleCommand[];
  unresolved: Unresolved[];
  /** All heredoc bodies and other free-form text found, for SQL scanning. */
  text: string[];
}

export interface ParseCtx {
  vars: Record<string, string>;
  cwd: string;
  platform: 'win32' | 'posix';
  depth: number;
}

export const MAX_DEPTH = 8;

export function emptyResult(): ParseResult {
  return { commands: [], unresolved: [], text: [] };
}

export function mergeResult(into: ParseResult, from: ParseResult): void {
  into.commands.push(...from.commands);
  into.unresolved.push(...from.unresolved);
  into.text.push(...from.text);
}

export function plainWord(value: string): Word {
  return { value, raw: value, dynamic: false, glob: false, quoted: false };
}
