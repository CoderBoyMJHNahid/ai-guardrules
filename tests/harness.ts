import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planSetup } from '../src/commands/setup.js';
import { applyChanges } from '../src/core/project.js';
import { canonicalPath } from '../src/guard/paths.js';
import type { ToolId } from '../src/adapters/types.js';
import type { PresetName } from '../src/core/rules-text.js';

export const REPO = path.resolve(import.meta.dirname, '..');
export const CLI = path.join(REPO, 'dist', 'cli.js');

export interface Installed {
  root: string;
  guard: string;
  cleanup: () => void;
}

/** A real temp project with ai-rules installed through the same code path as `init`. */
export function installProject(preset: PresetName = 'strict', tools: ToolId[] = ['claude', 'cursor', 'gemini', 'windsurf', 'codex', 'agents'], files: Record<string, string> = {}): Installed {
  const root = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rules-proj-')));
  const base: Record<string, string> = { '.env': 'SECRET=1\n', 'src/a.ts': 'export {}\n', 'existing.txt': 'x\n', 'package.json': '{"name":"t"}\n' };
  for (const [rel, content] of Object.entries({ ...base, ...files })) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const plan = planSetup({ root, preset, tools, localWrapper: false, force: false, presetChanged: false });
  applyChanges(root, plan.changes);
  return {
    root,
    guard: path.join(root, '.ai-rules', 'guard.mjs'),
    cleanup: () => {
      const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else fs.chmodSync(f, 0o644);
        }
      };
      try {
        walk(root);
      } catch {
        /* ignore */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function cli(root: string, ...args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, '-C', root, ...args], { encoding: 'utf8', env: { ...process.env, CI: '1' }, timeout: 60_000 });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
