import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Call, CustomGuard, CustomHook, Decision, Mode } from './types.js';

const MODES: Mode[] = ['allow', 'ask', 'deny', 'off'];
const GUARD_ON = ['shell', 'read', 'write', 'edit', 'mcp', 'any'];
const HOOK_EVENTS = ['before-shell', 'before-read', 'before-write', 'before-mcp', 'any'];

function readJson(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (raw.trim() === '') return null;
  return JSON.parse(raw);
}

export function validateGuard(g: unknown): CustomGuard {
  if (typeof g !== 'object' || g === null) throw new Error('custom guard must be an object');
  const o = g as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(o.id)) throw new Error('custom guard needs an id (letters, digits, . _ -)');
  if (!GUARD_ON.includes(o.on as string)) throw new Error(`custom guard ${o.id}: "on" must be one of ${GUARD_ON.join(', ')}`);
  if (!MODES.includes(o.decision as Mode)) throw new Error(`custom guard ${o.id}: "decision" must be one of ${MODES.join(', ')}`);
  for (const k of ['command', 'match', 'path'] as const) {
    if (o[k] !== undefined && typeof o[k] !== 'string') throw new Error(`custom guard ${o.id}: "${k}" must be a string`);
  }
  if (o.command === undefined && o.match === undefined && o.path === undefined) throw new Error(`custom guard ${o.id}: set at least one of command, match or path`);
  if (typeof o.message !== 'string' || o.message === '') throw new Error(`custom guard ${o.id}: "message" is required`);
  return o as unknown as CustomGuard;
}

export function validateHook(h: unknown): CustomHook {
  if (typeof h !== 'object' || h === null) throw new Error('custom hook must be an object');
  const o = h as Record<string, unknown>;
  if (typeof o.id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(o.id)) throw new Error('custom hook needs an id (letters, digits, . _ -)');
  if (!HOOK_EVENTS.includes(o.event as string)) throw new Error(`custom hook ${o.id}: "event" must be one of ${HOOK_EVENTS.join(', ')}`);
  if (typeof o.run !== 'string' || o.run.trim() === '') throw new Error(`custom hook ${o.id}: "run" is required`);
  if (o.timeoutMs !== undefined && (typeof o.timeoutMs !== 'number' || o.timeoutMs < 100 || o.timeoutMs > 30_000)) throw new Error(`custom hook ${o.id}: "timeoutMs" must be 100-30000`);
  return o as unknown as CustomHook;
}

export function loadCustomGuards(dir: string): CustomGuard[] {
  const data = readJson(path.join(dir, 'custom', 'guards.json'));
  if (data === null) return [];
  const list = Array.isArray(data) ? data : (data as { guards?: unknown }).guards;
  if (!Array.isArray(list)) throw new Error('custom/guards.json must be an array or { "guards": [] }');
  return list.map(validateGuard);
}

export function loadCustomHooks(dir: string): CustomHook[] {
  const data = readJson(path.join(dir, 'custom', 'hooks.json'));
  if (data === null) return [];
  const list = Array.isArray(data) ? data : (data as { hooks?: unknown }).hooks;
  if (!Array.isArray(list)) throw new Error('custom/hooks.json must be an array or { "hooks": [] }');
  return list.map(validateHook);
}

export function hookEventFor(call: Call): CustomHook['event'] {
  switch (call.kind) {
    case 'shell':
      return 'before-shell';
    case 'read':
    case 'search':
      return 'before-read';
    case 'write':
    case 'edit':
    case 'delete':
      return 'before-write';
    case 'mcp':
      return 'before-mcp';
    default:
      return 'any';
  }
}

export interface HookResult {
  decision: Decision;
  guard: string;
  message: string;
}

/** Payload given to custom hooks on stdin. */
export function hookPayload(call: Call, root: string): string {
  return JSON.stringify({
    event: hookEventFor(call),
    agent: call.tool,
    tool: call.toolName,
    kind: call.kind,
    command: call.command,
    paths: call.paths,
    patterns: call.patterns,
    mcp: call.mcp,
    cwd: call.cwd,
    projectRoot: root,
    session: call.session,
    input: call.input,
  });
}

/**
 * Run user hooks. They can only make the result stricter: exit 0 changes nothing,
 * exit 2 or JSON {"decision":"deny"|"ask"} restricts, and anything abnormal fails closed.
 */
export function runCustomHooks(hooks: CustomHook[], call: Call, root: string): HookResult[] {
  const event = hookEventFor(call);
  const results: HookResult[] = [];
  const payload = hookPayload(call, root);
  for (const hook of hooks) {
    if (hook.event !== 'any' && hook.event !== event) continue;
    const guard = `hook:${hook.id}`;
    const r = spawnSync(hook.run, { shell: true, input: payload, cwd: root, encoding: 'utf8', timeout: hook.timeoutMs ?? 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    if (r.error || r.signal) {
      results.push({ decision: 'deny', guard, message: `Custom hook "${hook.id}" failed or timed out (${r.error?.message ?? r.signal}).` });
      continue;
    }
    const out = (r.stdout ?? '').trim();
    const err = (r.stderr ?? '').trim();
    if (r.status === 2) {
      results.push({ decision: 'deny', guard, message: err || out || `Custom hook "${hook.id}" blocked this action.` });
      continue;
    }
    if (r.status !== 0) {
      results.push({ decision: 'deny', guard, message: `Custom hook "${hook.id}" exited with code ${r.status}.` });
      continue;
    }
    if (out === '') continue;
    try {
      const j = JSON.parse(out) as { decision?: string; reason?: string; message?: string };
      const msg = j.reason ?? j.message ?? `Custom hook "${hook.id}" restricted this action.`;
      if (j.decision === 'deny') results.push({ decision: 'deny', guard, message: msg });
      else if (j.decision === 'ask') results.push({ decision: 'ask', guard, message: msg });
      else if (j.decision !== undefined && j.decision !== 'allow') results.push({ decision: 'deny', guard, message: `Custom hook "${hook.id}" returned an unknown decision.` });
    } catch {
      results.push({ decision: 'deny', guard, message: `Custom hook "${hook.id}" printed output that is not valid JSON.` });
    }
  }
  return results;
}
