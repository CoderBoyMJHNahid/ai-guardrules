import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, type DecideCtx } from '../src/guard/decide.js';
import { canonicalPath, defaultEnv } from '../src/guard/paths.js';
import { presetPolicy } from '../src/guard/policy.js';
import type { Call, CallKind, CustomGuard, Dialect, Grant, Policy } from '../src/guard/types.js';

export interface Project {
  root: string;
  cleanup: () => void;
}

export function makeProject(files: Record<string, string> = {}): Project {
  const base = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rules-test-')));
  const defaults: Record<string, string> = {
    '.env': 'SECRET=1',
    '.env.example': 'SECRET=',
    'src/a.ts': 'export const a = 1;\n',
    'README.md': '# hi\n',
    'CLAUDE.md': '@AGENTS.md\n',
    'AGENTS.md': '# rules\n',
    '.claude/settings.json': '{}\n',
    '.ai-rules/policy.json': '{}\n',
    'existing.txt': 'x\n',
    'dir/inside.txt': 'y\n',
  };
  for (const [rel, content] of Object.entries({ ...defaults, ...files })) {
    const abs = path.join(base, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { root: base, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export function ctxFor(root: string, preset: 'strict' | 'standard' | Policy = 'strict', extra: { grants?: Grant[]; customGuards?: CustomGuard[] } = {}): DecideCtx {
  const policy = typeof preset === 'string' ? presetPolicy(preset) : preset;
  return { root, policy, env: defaultEnv(root), grants: extra.grants ?? [], customGuards: extra.customGuards ?? [] };
}

/** A fake Windows environment (path.win32 semantics, in-memory filesystem). */
export function winCtx(preset: 'strict' | 'standard' = 'strict', existing: string[] = ['C:\\proj\\src\\a.ts', 'C:\\proj\\.env', 'C:\\proj\\existing.txt']): DecideCtx {
  const root = 'C:\\proj';
  const set = new Set(existing.map((p) => p.toLowerCase()));
  const env = {
    ...defaultEnv(root),
    api: path.win32 as typeof path.posix,
    platform: 'win32' as const,
    caseInsensitive: true,
    home: 'C:\\Users\\me',
    realpath: (p: string) => p,
    exists: (p: string) => set.has(p.toLowerCase()),
    isSymlink: () => false,
    isFile: (p: string) => set.has(p.toLowerCase()),
    isDir: () => false,
    vars: { USERPROFILE: 'C:\\Users\\me', HOME: 'C:\\Users\\me', PROJECT_DIR: root } as Record<string, string>,
  };
  return { policy: presetPolicy(preset), root, env, grants: [], customGuards: [] };
}

export function shellCall(root: string, command: string, dialect: Dialect = 'bash', cwd?: string): Call {
  return { kind: 'shell', tool: 'claude', toolName: 'Bash', cwd: cwd ?? root, command, dialect };
}

export function fileCall(root: string, kind: CallKind, file: string, toolName = 'Write', patterns?: string[]): Call {
  return { kind, tool: 'claude', toolName, cwd: root, paths: [file], patterns };
}

export function run(ctx: DecideCtx, call: Call) {
  return decide(call, ctx);
}

export function sh(ctx: DecideCtx, command: string, dialect: Dialect = 'bash') {
  return decide(shellCall(ctx.root, command, dialect), ctx).verdict;
}
