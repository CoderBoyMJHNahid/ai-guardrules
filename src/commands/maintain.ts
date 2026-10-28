import fs from 'node:fs';
import * as p from '@clack/prompts';
import { ADAPTERS, TOOL_IDS } from '../adapters/index.js';
import type { ToolId } from '../adapters/types.js';
import { runDoctor, summarize } from '../core/doctor.js';
import { aiDir, applyChanges, isInstalled, readManifest, readPolicy, relock, type Manifest } from '../core/project.js';
import { verifyLock } from '../guard/integrity.js';
import { loadGrants } from '../guard/grants.js';
import { GUARD_NAMES } from '../guard/policy.js';
import { CliError, isInteractive, out, pc } from '../ui.js';
import { planSetup, planTeardown } from './setup.js';
import { makeWritableTree } from '../core/rm.js';

export function requireInstalled(root: string): Manifest {
  const m = readManifest(root);
  if (!m || !isInstalled(root)) throw new CliError('ai-guardrules is not installed in this folder. Run "npx ai-guardrules init" first.');
  return m;
}

/** Re-render everything from the manifest, keeping custom files and the user's policy choices. */
export function refreshInstall(root: string, o: { dryRun?: boolean; force?: boolean } = {}): { applied: ReturnType<typeof applyChanges>; warnings: string[] } {
  const m = requireInstalled(root);
  const plan = planSetup({ root, preset: m.preset, tools: m.tools, localWrapper: m.localWrapper, force: o.force ?? false, presetChanged: false });
  const applied = applyChanges(root, plan.changes, { dryRun: o.dryRun });
  return { applied, warnings: plan.warnings };
}

export function runUpdate(root: string, o: { dryRun?: boolean; force?: boolean }): void {
  requireInstalled(root);
  const { applied, warnings } = refreshInstall(root, o);
  out.heading(o.dryRun ? 'Dry run: nothing was written' : 'ai-guardrules updated');
  if (applied.length === 0) out.line('Everything is already up to date.');
  for (const a of applied) out.line(`  ${a.action.padEnd(8)} ${a.file}`);
  for (const w of warnings) out.warn(w);
  if (o.dryRun) return;
  const { failed } = summarize(runDoctor(root));
  if (failed > 0) throw new CliError('Updated, but the self-test failed. Run "ai-guardrules doctor" for details.');
  out.ok('self-test passed');
}

export function runLock(root: string): void {
  requireInstalled(root);
  const before = verifyLock(aiDir(root));
  relock(root);
  if (before.ok) out.ok('Lock was already current.');
  else {
    out.ok('Lock refreshed. These changes are now trusted:');
    for (const pr of before.problems) out.line(`  - ${pr}`);
  }
}

export async function runRemove(root: string, o: { yes?: boolean; dryRun?: boolean; keepCustom?: boolean; all?: boolean }): Promise<void> {
  const m = requireInstalled(root);
  const tools: ToolId[] = o.all ? [...TOOL_IDS] : m.tools;
  const changes = planTeardown(root, tools, m.preset, m.localWrapper);
  const dir = aiDir(root);
  out.heading(o.dryRun ? 'Dry run: nothing was removed' : 'Removing ai-guardrules');
  for (const a of applyChanges(root, changes, { dryRun: true })) out.line(`  ${a.action.padEnd(8)} ${a.file}`);
  out.line(`  removed  .ai-guardrules/${o.keepCustom ? ' (custom/ is kept)' : ''}`);
  if (o.dryRun) return;
  if (isInteractive() && !o.yes) {
    const ok = await p.confirm({ message: 'Remove the guardrails from this project?', initialValue: false });
    if (p.isCancel(ok) || !ok) throw new CliError('Cancelled. Nothing was removed.', 130);
  } else if (!o.yes && !isInteractive()) {
    throw new CliError('Refusing to remove guardrails without --yes in a non-interactive shell.');
  }
  applyChanges(root, changes);
  makeWritableTree(dir);
  if (o.keepCustom) {
    for (const entry of fs.readdirSync(dir)) if (entry !== 'custom') fs.rmSync(`${dir}/${entry}`, { recursive: true, force: true });
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  out.ok('ai-guardrules removed. Agents are no longer restricted by these guardrails.');
}

export function runStatus(root: string): void {
  const m = readManifest(root);
  if (!m || !isInstalled(root)) {
    out.line('ai-guardrules is not installed in this folder.');
    out.dim('Run "npx ai-guardrules init" to set it up.');
    return;
  }
  const policy = readPolicy(root);
  const lock = verifyLock(aiDir(root));
  let grants = 0;
  try {
    grants = loadGrants(aiDir(root)).length;
  } catch {
    /* doctor reports it */
  }
  out.heading(`ai-guardrules ${m.packageVersion}`);
  out.line(`  preset      ${m.preset}${policy && policy.preset === 'custom' ? pc.dim(' (customised with policy set)') : ''}`);
  out.line(`  integrity   ${lock.ok ? pc.green('locked and intact') : pc.red('MODIFIED: ' + lock.problems.join('; '))}`);
  out.line(`  grants      ${grants} active`);
  out.heading('Tools');
  for (const t of m.tools) out.line(`  ${ADAPTERS[t].label.padEnd(15)} ${ADAPTERS[t].enforcement === 'enforced' ? pc.green('enforced') : pc.yellow('advisory')}`);
  if (policy) {
    out.heading('Guards');
    const rows = GUARD_NAMES.map((g) => `  ${g.padEnd(15)} ${policy.guards[g]}`);
    out.line(rows.join('\n'));
  }
  if (!lock.ok) out.warn('Run "ai-guardrules doctor" for details. If you made these changes, "ai-guardrules lock" trusts them.');
}
