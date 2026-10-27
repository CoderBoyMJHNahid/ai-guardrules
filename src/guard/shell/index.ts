import type { Dialect } from '../types.js';
import { parseBashRaw, type RawParse } from './bash.js';
import { parseCmdRaw } from './cmd.js';
import { emptyResult, MAX_DEPTH, type ParseCtx, type ParseResult } from './model.js';
import { parsePowerShellRaw } from './powershell.js';
import { finalize, type NestedParser } from './unwrap.js';

export * from './model.js';
export { normName } from './unwrap.js';

function rawFor(script: string, dialect: Dialect, ctx: ParseCtx): RawParse {
  switch (dialect) {
    case 'powershell':
      return parsePowerShellRaw(script, ctx);
    case 'cmd':
      return parseCmdRaw(script, ctx);
    default:
      return parseBashRaw(script, ctx);
  }
}

const nested: NestedParser = (script, dialect, ctx, res, via) => {
  if (ctx.depth > MAX_DEPTH) {
    res.unresolved.push({ reason: 'too-deeply-nested', detail: script.slice(0, 80), severity: 'deny' });
    return;
  }
  const raw = rawFor(script, dialect, ctx);
  res.unresolved.push(...raw.unresolved);
  res.text.push(...raw.text, script);
  finalize(raw.raws, dialect, ctx, res, nested, via);
};

/** Parse a shell command string into normalized simple commands. */
export function parseShell(command: string, dialect: Dialect, ctx: Omit<ParseCtx, 'depth'> & { depth?: number }): ParseResult {
  const full: ParseCtx = { depth: 0, ...ctx };
  const res = emptyResult();
  res.text.push(command);
  const raw = rawFor(command, dialect, full);
  res.unresolved.push(...raw.unresolved);
  res.text.push(...raw.text);
  finalize(raw.raws, dialect, full, res, nested);
  return res;
}
