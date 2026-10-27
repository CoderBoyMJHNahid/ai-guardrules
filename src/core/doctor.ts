import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAdapter } from '../adapters/index.js';
import type { AdapterCtx, ToolId } from '../adapters/types.js';
import { loadCustomGuards, loadCustomHooks } from '../guard/custom.js';
import { loadGrants } from '../guard/grants.js';
import { verifyLock } from '../guard/integrity.js';
import { isAgent, type AgentId } from '../guard/normalize.js';
import { validatePolicy } from '../guard/policy.js';
import { isReadOnly, readText } from './fsutil.js';
import { aiDir, aiPath, readCustomRules, readManifest, READ_ONLY_FILES } from './project.js';
import { runGuard } from './runGuard.js';
import { isAsking, isBlocked, samplePayload } from './samples.js';

export interface DoctorCheck {
  group: string;
  label: string;
  ok: boolean;
  /** Failures that leave the project unprotected. Non-critical failures are warnings. */
  critical: boolean;
  detail?: string;
}

const ENFORCED: ToolId[] = ['claude', 'cursor', 'gemini', 'windsurf', 'codex'];

interface Attack {
  name: string;
  kind: 'shell' | 'read' | 'write';
  value: (root: string) => string;
  /** Presets where this must be blocked. */
  presets: Array<'strict' | 'standard'>;
}

const ATTACKS: Attack[] = [
  { name: 'read a secret (cat .env)', kind: 'shell', value: () => 'cat .env', presets: ['strict', 'standard'] },
  { name: 'read a secret file with the file tool', kind: 'read', value: (r) => path.join(r, '.env'), presets: ['strict', 'standard'] },
  { name: 'edit the guardrails', kind: 'write', value: (r) => path.join(r, '.ai-rules', 'policy.json'), presets: ['strict', 'standard'] },
  { name: 'drop a database table', kind: 'shell', value: () => 'psql -c "DROP TABLE users"', presets: ['strict', 'standard'] },
  { name: 'force push', kind: 'shell', value: () => 'git push --force', presets: ['strict', 'standard'] },
  { name: 'recursive delete of the filesystem root', kind: 'shell', value: () => 'rm -rf /', presets: ['strict', 'standard'] },
  { name: 'git push', kind: 'shell', value: () => 'git push origin main', presets: ['strict'] },
  { name: 'delete a file', kind: 'shell', value: () => 'rm notes.txt', presets: ['strict'] },
  { name: 'read outside the project', kind: 'shell', value: () => 'cat ../outside.txt', presets: ['strict'] },
];

function withTempGuard(guardPath: string, fn: (dir: string) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rules-doctor-'));
  try {
    fs.mkdirSync(path.join(tmp, '.ai-rules'));
    fs.copyFileSync(guardPath, path.join(tmp, '.ai-rules', 'guard.mjs'));
    fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function selfTest(root: string, tools: ToolId[], preset: 'strict' | 'standard' | 'custom'): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  const guard = aiPath(root, 'guard.mjs');
  const agents = tools.filter((t): t is AgentId => ENFORCED.includes(t) && isAgent(t));
  const effective = preset === 'custom' ? 'standard' : preset;
  for (const agent of agents) {
    for (const a of ATTACKS) {
      if (!a.presets.includes(effective)) continue;
      const r = runGuard(guard, agent, samplePayload(agent, a.kind, a.value(root), root), root);
      out.push({ group: 'Self-test', label: `${agent}: blocks "${a.name}"`, ok: isBlocked(agent, r), critical: true, detail: isBlocked(agent, r) ? undefined : `exit ${r.code}, output: ${(r.stdout || r.stderr).trim().slice(0, 120) || '(none)'}` });
    }
    if (effective === 'strict') {
      const g = runGuard(guard, agent, samplePayload(agent, 'shell', 'git status', root), root);
      out.push({ group: 'Self-test', label: `${agent}: allows read-only git`, ok: !isBlocked(agent, g) && !isAsking(agent, g), critical: false, detail: `exit ${g.code}` });
    }
    const garbage = runGuard(guard, agent, 'this is not json', root);
    out.push({ group: 'Self-test', label: `${agent}: blocks unreadable input (fail-closed)`, ok: isBlocked(agent, garbage), critical: true });
  }
  if (agents.length) {
    const agent = agents[0] as AgentId;
    withTempGuard(guard, (tmp) => {
      const r = runGuard(path.join(tmp, '.ai-rules', 'guard.mjs'), agent, samplePayload(agent, 'shell', 'git status', tmp), tmp);
      out.push({ group: 'Self-test', label: 'blocks everything when policy and lock files are missing', ok: isBlocked(agent, r), critical: true });
    });
  }
  return out;
}

export function runDoctor(root: string, o: { selfTest?: boolean } = {}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck): void => {
    checks.push(c);
  };
  const manifest = readManifest(root);
  if (!manifest || !fs.existsSync(aiPath(root, 'guard.mjs'))) {
    add({ group: 'Install', label: 'ai-rules is installed', ok: false, critical: true, detail: 'Run "npx ai-rules init".' });
    return checks;
  }
  add({ group: 'Install', label: `ai-rules ${manifest.packageVersion}, preset ${manifest.preset}`, ok: true, critical: false });

  const major = Number(process.versions.node.split('.')[0]);
  add({ group: 'Install', label: `Node ${process.versions.node} (guard needs 20 or newer)`, ok: major >= 20, critical: true, detail: 'Hooks run with the node found on PATH.' });

  const lock = verifyLock(aiDir(root));
  add({ group: 'Integrity', label: 'guard, policy and custom files match the lock', ok: lock.ok, critical: true, detail: lock.ok ? undefined : lock.problems.join('; ') + '. If you made these changes, run "ai-rules lock".' });
  try {
    validatePolicy(JSON.parse(readText(aiPath(root, 'policy.json')) ?? ''));
    add({ group: 'Integrity', label: 'policy.json is valid', ok: true, critical: true });
  } catch (e) {
    add({ group: 'Integrity', label: 'policy.json is valid', ok: false, critical: true, detail: (e as Error).message });
  }
  for (const [label, fn] of [
    ['custom/guards.json is valid', () => loadCustomGuards(aiDir(root))],
    ['custom/hooks.json is valid', () => loadCustomHooks(aiDir(root))],
    ['grants.json is valid', () => loadGrants(aiDir(root))],
  ] as const) {
    try {
      fn();
      add({ group: 'Integrity', label, ok: true, critical: true });
    } catch (e) {
      add({ group: 'Integrity', label, ok: false, critical: true, detail: (e as Error).message });
    }
  }
  const writable = READ_ONLY_FILES.filter((f) => fs.existsSync(aiPath(root, f)) && !isReadOnly(aiPath(root, f)));
  add({ group: 'Integrity', label: 'guard files are read-only', ok: writable.length === 0, critical: false, detail: writable.length ? `Writable: ${writable.join(', ')}. Run "ai-rules lock".` : undefined });

  const ctx: AdapterCtx = { root, preset: manifest.preset, customRules: readCustomRules(root), localWrapper: manifest.localWrapper, force: false };
  for (const tool of manifest.tools) {
    const adapter = getAdapter(tool);
    for (const item of adapter.check(ctx)) {
      add({ group: adapter.label, label: item.label, ok: item.ok, critical: item.critical !== false, detail: item.detail });
    }
  }

  if (o.selfTest !== false && lock.ok) checks.push(...selfTest(root, manifest.tools, manifest.preset));
  return checks;
}

export function summarize(checks: DoctorCheck[]): { failed: number; warned: number } {
  return { failed: checks.filter((c) => !c.ok && c.critical).length, warned: checks.filter((c) => !c.ok && !c.critical).length };
}
