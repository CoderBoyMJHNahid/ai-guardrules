import * as p from '@clack/prompts';
import { ADAPTERS, TOOL_IDS, parseTools } from '../adapters/index.js';
import type { ToolId } from '../adapters/types.js';
import { runDoctor, summarize } from '../core/doctor.js';
import { applyChanges, readManifest } from '../core/project.js';
import type { PresetName } from '../core/rules-text.js';
import { CliError, isInteractive, out, pc } from '../ui.js';
import { planSetup } from './setup.js';

export interface InitOptions {
  tools?: string;
  preset?: string;
  all?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  force?: boolean;
  localWrapper?: boolean;
}

function parsePreset(v: string): PresetName {
  if (v === 'strict' || v === 'standard') return v;
  throw new CliError(`Unknown preset "${v}". Use strict or standard.`);
}

export async function runInit(root: string, o: InitOptions): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new CliError(`ai-guardrules needs Node 20 or newer (found ${process.versions.node}).`);

  const existing = readManifest(root);
  const interactive = isInteractive() && !o.yes;

  // Preset
  let preset: PresetName;
  if (o.preset) preset = parsePreset(o.preset);
  else if (existing) preset = existing.preset;
  else if (interactive) {
    const answer = await p.select({
      message: 'Which preset?',
      initialValue: 'strict',
      options: [
        { value: 'strict', label: 'strict (recommended)', hint: 'every command needs approval, read-only git, no deletes, stay in the project, no new files, no DB changes' },
        { value: 'standard', label: 'standard', hint: 'blocks secrets and destructive commands only' },
      ],
    });
    if (p.isCancel(answer)) throw new CliError('Cancelled.', 130);
    preset = answer as PresetName;
  } else preset = 'strict';

  // Tools
  const detected = TOOL_IDS.filter((t) => ADAPTERS[t].detect(root));
  let tools: ToolId[];
  if (o.tools) tools = parseTools(o.tools);
  else if (o.all) tools = [...TOOL_IDS];
  else {
    const initial = new Set<ToolId>([...detected, ...(existing?.tools ?? []), 'agents']);
    if (detected.length === 0 && !existing) {
      initial.add('claude');
      initial.add('cursor');
    }
    if (interactive) {
      const answer = await p.multiselect({
        message: 'Which AI tools do you use here?',
        initialValues: [...initial],
        options: TOOL_IDS.map((t) => ({ value: t, label: ADAPTERS[t].label, hint: `${ADAPTERS[t].enforcement}${detected.includes(t) ? ', detected' : ''}` })),
        required: true,
      });
      if (p.isCancel(answer)) throw new CliError('Cancelled.', 130);
      tools = answer as ToolId[];
    } else tools = [...initial];
  }
  tools = [...new Set([...tools, ...(existing?.tools ?? []), 'agents' as ToolId])];

  const plan = planSetup({ root, preset, tools, localWrapper: o.localWrapper ?? existing?.localWrapper ?? false, force: o.force ?? false, presetChanged: existing !== null && existing.preset !== preset });

  if (o.dryRun) {
    out.heading('Dry run: nothing was written');
    if (plan.changes.length === 0) out.line('Everything is already up to date.');
    for (const a of applyChanges(root, plan.changes, { dryRun: true })) {
      const note = plan.changes.find((c) => c.file === a.file)?.note ?? '';
      out.line(`  ${a.action.padEnd(8)} ${a.file}  ${pc.dim(note)}`);
    }
    for (const w of plan.warnings) out.warn(w);
    return;
  }

  const applied = applyChanges(root, plan.changes);
  out.heading(existing ? 'ai-guardrules refreshed' : 'ai-guardrules installed');
  if (applied.length === 0) out.line('Everything was already up to date.');
  for (const a of applied) out.line(`  ${a.action.padEnd(8)} ${a.file}`);

  out.heading(`Protection (${preset} preset)`);
  for (const t of tools) {
    const a = ADAPTERS[t];
    const tag = a.enforcement === 'enforced' ? pc.green('enforced') : pc.yellow('advisory');
    out.line(`  ${a.label.padEnd(15)} ${tag}  ${pc.dim(a.summary)}`);
  }
  for (const w of plan.warnings) out.warn(w);

  const checks = runDoctor(root);
  const { failed } = summarize(checks);
  if (failed > 0) {
    out.heading('Self-test found problems');
    for (const c of checks.filter((x) => !x.ok && x.critical)) out.fail(`${c.label}${c.detail ? ` - ${c.detail}` : ''}`);
    throw new CliError('Install finished, but the self-test failed. Run "ai-guardrules doctor" for details.');
  }
  out.heading('Self-test passed');
  out.line('The installed hooks blocked every attack payload we replayed through them.');
  out.dim('Next: commit .ai-guardrules/ and the hook configs so teammates get the same guardrails. Approve a blocked action with "ai-guardrules allow".');
}
