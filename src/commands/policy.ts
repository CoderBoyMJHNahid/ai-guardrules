import { readPolicy, writeLocked } from '../core/project.js';
import { newJson } from '../core/json.js';
import { GUARD_DESCRIPTIONS, GUARD_NAMES, HARD_GUARD_NAMES, type GuardName } from '../guard/policy.js';
import type { Mode } from '../guard/types.js';
import { CliError, out, pc, table } from '../ui.js';
import { requireInstalled } from './maintain.js';

const MODES: Mode[] = ['allow', 'ask', 'deny', 'off'];

export function runPolicyShow(root: string): void {
  requireInstalled(root);
  const policy = readPolicy(root);
  if (!policy) throw new CliError('policy.json is missing.');
  const rows = GUARD_NAMES.map((g) => [g, policy.guards[g] ?? '?', HARD_GUARD_NAMES.includes(g) ? 'fixed at deny' : '', GUARD_DESCRIPTIONS[g]]);
  out.line(`Preset: ${policy.preset}`);
  out.line(table([['guard', 'mode', '', 'what it does'], ...rows]));
  out.dim('\nChange one with: ai-guardrules policy set <guard> <allow|ask|deny|off>');
}

export function runPolicySet(root: string, guard: string, mode: string): void {
  requireInstalled(root);
  if (!(GUARD_NAMES as readonly string[]).includes(guard)) throw new CliError(`Unknown guard "${guard}". Choose from: ${GUARD_NAMES.join(', ')}`);
  if (!MODES.includes(mode as Mode)) throw new CliError(`Unknown mode "${mode}". Choose from: ${MODES.join(', ')}`);
  if (HARD_GUARD_NAMES.includes(guard as GuardName) && mode !== 'deny') {
    throw new CliError(`"${guard}" protects secrets, databases, destructive actions or the guardrails themselves. It always stays at deny and cannot be relaxed.`);
  }
  const policy = readPolicy(root);
  if (!policy) throw new CliError('policy.json is missing.');
  const previous = policy.guards[guard];
  policy.guards[guard] = mode as Mode;
  policy.preset = 'custom';
  writeLocked(root, 'policy.json', newJson(policy));
  out.ok(`${guard}: ${previous} -> ${pc.bold(mode)}`);
}
