import { spawnSync } from 'node:child_process';
import { aiDir, readCustomRules, writeLocked } from '../core/project.js';
import { newJson } from '../core/json.js';
import { previewCtx, previewPath, previewShell } from '../core/preview.js';
import { hookPayload, loadCustomGuards, loadCustomHooks, validateGuard, validateHook } from '../guard/custom.js';
import { decide } from '../guard/decide.js';
import type { Call, CustomGuard, CustomHook } from '../guard/types.js';
import { CliError, out, pc, table } from '../ui.js';
import { refreshInstall, requireInstalled } from './maintain.js';

// ---------------------------------------------------------------------------
// Rules (markdown guidance for agents)
// ---------------------------------------------------------------------------

function ruleLines(root: string): string[] {
  return readCustomRules(root)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
}

function saveRules(root: string, lines: string[]): void {
  writeLocked(root, 'custom/rules.md', lines.length ? lines.map((l) => `- ${l}`).join('\n') + '\n' : '');
  const { warnings } = refreshInstall(root);
  for (const w of warnings) out.warn(w);
}

export function runRuleAdd(root: string, text: string): void {
  requireInstalled(root);
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) throw new CliError('Give the rule text, for example: ai-guardrules rule add "Use pnpm, never npm"');
  const lines = ruleLines(root);
  if (lines.includes(t)) throw new CliError('That rule already exists.');
  saveRules(root, [...lines, t]);
  out.ok(`Rule added and written to AGENTS.md and the other rule files: ${t}`);
  out.dim('Rules are guidance for the agent. To actually block something, use "ai-guardrules guard add".');
}

export function runRuleList(root: string): void {
  requireInstalled(root);
  const lines = ruleLines(root);
  if (lines.length === 0) out.line('No custom rules. Add one with: ai-guardrules rule add "..."');
  lines.forEach((l, i) => out.line(`  ${i + 1}. ${l}`));
}

export function runRuleRemove(root: string, which: string): void {
  requireInstalled(root);
  const lines = ruleLines(root);
  const n = Number(which);
  const idx = Number.isInteger(n) && n >= 1 && n <= lines.length ? n - 1 : lines.findIndex((l) => l === which);
  if (idx < 0) throw new CliError(`No rule "${which}". See "ai-guardrules rule list".`);
  const [removed] = lines.splice(idx, 1);
  saveRules(root, lines);
  out.ok(`Removed: ${removed}`);
}

// ---------------------------------------------------------------------------
// Guards (enforced by the guard script, can only be stricter)
// ---------------------------------------------------------------------------

export interface GuardAddOptions {
  id?: string;
  on?: string;
  command?: string;
  match?: string;
  path?: string;
  decision?: string;
  message?: string;
}

function guardsFile(root: string): CustomGuard[] {
  return loadCustomGuards(aiDir(root));
}

function saveGuards(root: string, guards: CustomGuard[]): void {
  writeLocked(root, 'custom/guards.json', newJson({ guards }));
}

export function runGuardAdd(root: string, o: GuardAddOptions): void {
  requireInstalled(root);
  const guard = validateGuard({
    id: o.id,
    on: o.on ?? 'shell',
    command: o.command,
    match: o.match,
    path: o.path,
    decision: o.decision ?? 'deny',
    message: o.message,
  });
  const guards = guardsFile(root);
  if (guards.some((g) => g.id === guard.id)) throw new CliError(`A guard with id "${guard.id}" already exists. Remove it first.`);
  saveGuards(root, [...guards, guard]);
  out.ok(`Guard "${guard.id}" added (${guard.decision}).`);
  out.dim('Custom guards can only make the result stricter. They never relax a built-in deny.');
}

export function runGuardList(root: string): void {
  requireInstalled(root);
  const guards = guardsFile(root);
  if (guards.length === 0) {
    out.line('No custom guards. Add one with: ai-guardrules guard add --id <id> --command <name> --match "<glob>" --decision deny --message "<why>"');
    return;
  }
  out.line(table([['id', 'on', 'matches', 'decision', 'message'], ...guards.map((g) => [g.id, g.on, [g.command && `cmd=${g.command}`, g.match && `match=${g.match}`, g.path && `path=${g.path}`].filter(Boolean).join(' '), g.decision, g.message])]));
}

export function runGuardRemove(root: string, id: string): void {
  requireInstalled(root);
  const guards = guardsFile(root);
  const left = guards.filter((g) => g.id !== id);
  if (left.length === guards.length) throw new CliError(`No guard with id "${id}".`);
  saveGuards(root, left);
  out.ok(`Removed guard "${id}".`);
}

export function printDecision(r: ReturnType<typeof decide>): void {
  const v = r.verdict;
  const colour = v.decision === 'allow' ? pc.green : v.decision === 'ask' ? pc.yellow : pc.red;
  out.line(`${colour(v.decision.toUpperCase())}  ${v.guard}`);
  if (v.message) out.line(`  ${v.message}`);
  if (v.decision !== 'allow') out.line(`  grantable: ${v.grantable ? 'yes, with "ai-guardrules allow"' : 'no (fixed rule)'}`);
  if (r.candidates.length > 1) {
    out.dim('  all matching guards:');
    for (const c of r.candidates) out.dim(`    ${c.decision.padEnd(5)} ${c.guard}: ${c.message}`);
  }
}

export function runGuardTest(root: string, input: string, o: { read?: boolean; write?: boolean; delete?: boolean; powershell?: boolean; cmd?: boolean }): void {
  requireInstalled(root);
  if (o.read) printDecision(previewPath(root, 'read', input));
  else if (o.write) printDecision(previewPath(root, 'write', input));
  else if (o.delete) printDecision(previewPath(root, 'delete', input));
  else printDecision(previewShell(root, input, { dialect: o.powershell ? 'powershell' : o.cmd ? 'cmd' : undefined }));
}

// ---------------------------------------------------------------------------
// Hooks (user scripts run by the guard, can only be stricter)
// ---------------------------------------------------------------------------

export interface HookAddOptions {
  id?: string;
  event?: string;
  run?: string;
  timeout?: string;
}

function hooksFile(root: string): CustomHook[] {
  return loadCustomHooks(aiDir(root));
}

function saveHooks(root: string, hooks: CustomHook[]): void {
  writeLocked(root, 'custom/hooks.json', newJson({ hooks }));
}

export function runHookAdd(root: string, o: HookAddOptions): void {
  requireInstalled(root);
  const hook = validateHook({ id: o.id, event: o.event ?? 'before-shell', run: o.run, timeoutMs: o.timeout ? Number(o.timeout) : undefined });
  const hooks = hooksFile(root);
  if (hooks.some((h) => h.id === hook.id)) throw new CliError(`A hook with id "${hook.id}" already exists. Remove it first.`);
  saveHooks(root, [...hooks, hook]);
  out.ok(`Hook "${hook.id}" added for ${hook.event}.`);
  out.dim('The script gets the action as JSON on stdin. Exit 0 = no objection, exit 2 or {"decision":"deny"} = block. A crash or timeout blocks too.');
}

export function runHookList(root: string): void {
  requireInstalled(root);
  const hooks = hooksFile(root);
  if (hooks.length === 0) {
    out.line('No custom hooks. Add one with: ai-guardrules hook add --id <id> --event before-shell --run "<command>"');
    return;
  }
  out.line(table([['id', 'event', 'run'], ...hooks.map((h) => [h.id, h.event, h.run])]));
}

export function runHookRemove(root: string, id: string): void {
  requireInstalled(root);
  const hooks = hooksFile(root);
  const left = hooks.filter((h) => h.id !== id);
  if (left.length === hooks.length) throw new CliError(`No hook with id "${id}".`);
  saveHooks(root, left);
  out.ok(`Removed hook "${id}".`);
}

export function runHookTest(root: string, id: string, o: { command?: string; file?: string }): void {
  requireInstalled(root);
  const hook = hooksFile(root).find((h) => h.id === id);
  if (!hook) throw new CliError(`No hook with id "${id}".`);
  const ctx = previewCtx(root);
  const call: Call = o.file
    ? { kind: 'write', tool: 'cli', toolName: 'Write', cwd: ctx.root, paths: [o.file] }
    : { kind: 'shell', tool: 'cli', toolName: 'Bash', cwd: ctx.root, command: o.command ?? 'echo hello', dialect: process.platform === 'win32' ? 'powershell' : 'bash' };
  const payload = hookPayload(call, ctx.root);
  out.dim(`payload: ${payload}`);
  const r = spawnSync(hook.run, { shell: true, input: payload, cwd: ctx.root, encoding: 'utf8', timeout: hook.timeoutMs ?? 5000 });
  out.line(`exit code: ${r.status ?? 'none'}${r.error ? ` (${r.error.message})` : ''}${r.signal ? ` (signal ${r.signal})` : ''}`);
  if (r.stdout.trim()) out.line(`stdout: ${r.stdout.trim()}`);
  if (r.stderr.trim()) out.line(`stderr: ${r.stderr.trim()}`);
  const blocks = r.error || r.signal || r.status !== 0;
  out.line(blocks ? pc.red('This hook would block the action (anything abnormal fails closed).') : pc.green('This hook would not object.'));
}
