import { getAdapter } from '../adapters/index.js';
import type { AdapterCtx, Change, ToolId } from '../adapters/types.js';
import { planCore, planRemoveCore, readCustomRules, type CorePlan } from '../core/project.js';
import type { PresetName } from '../core/rules-text.js';

export interface SetupInput {
  root: string;
  preset: PresetName;
  tools: ToolId[];
  localWrapper: boolean;
  force: boolean;
  presetChanged: boolean;
}

export interface SetupPlan {
  changes: Change[];
  warnings: string[];
  core: CorePlan;
}

/** Everything needed to install or refresh, computed before anything is written. */
export function planSetup(i: SetupInput): SetupPlan {
  const tools = i.tools.includes('agents') ? i.tools : [...i.tools, 'agents' as ToolId];
  const core = planCore(i.root, { preset: i.preset, tools, localWrapper: i.localWrapper, presetChanged: i.presetChanged });
  const ctx: AdapterCtx = { root: i.root, preset: i.preset, customRules: readCustomRules(i.root), localWrapper: i.localWrapper, force: i.force };
  const changes: Change[] = [...core.changes];
  const warnings: string[] = [];
  for (const t of tools) {
    const r = getAdapter(t).install(ctx);
    changes.push(...r.changes);
    warnings.push(...r.warnings);
  }
  return { changes, warnings, core };
}

export function planTeardown(root: string, tools: ToolId[], preset: PresetName, localWrapper: boolean): Change[] {
  const ctx: AdapterCtx = { root, preset, customRules: '', localWrapper, force: false };
  const changes: Change[] = [];
  for (const t of tools) changes.push(...getAdapter(t).uninstall(ctx).changes);
  changes.push(...planRemoveCore(root));
  return changes;
}
