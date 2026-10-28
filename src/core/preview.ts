import { decide, type DecideCtx, type DecideResult } from '../guard/decide.js';
import { loadCustomGuards } from '../guard/custom.js';
import { loadGrants } from '../guard/grants.js';
import { canonicalPath, defaultEnv } from '../guard/paths.js';
import type { Call, Dialect } from '../guard/types.js';
import { aiDir, readPolicy } from './project.js';

/** Build the same decision context the guard uses, for CLI previews and tests. */
export function previewCtx(root: string, o: { withGrants?: boolean } = {}): DecideCtx {
  const real = canonicalPath(root);
  const policy = readPolicy(root);
  if (!policy) throw new Error('ai-rules is not installed here. Run "npx ai-rules init".');
  return {
    root: real,
    policy,
    env: defaultEnv(real),
    grants: o.withGrants === false ? [] : loadGrants(aiDir(root)),
    customGuards: loadCustomGuards(aiDir(root)),
  };
}

export function previewShell(root: string, command: string, o: { dialect?: Dialect; withGrants?: boolean } = {}): DecideResult {
  const ctx = previewCtx(root, o);
  const dialect = o.dialect ?? (process.platform === 'win32' ? 'powershell' : 'bash');
  const call: Call = { kind: 'shell', tool: 'cli', toolName: 'Bash', cwd: ctx.root, command, dialect };
  return decide(call, ctx);
}

export function previewPath(root: string, kind: 'read' | 'write' | 'edit' | 'delete', file: string): DecideResult {
  const ctx = previewCtx(root);
  const call: Call = { kind, tool: 'cli', toolName: kind, cwd: ctx.root, paths: [file] };
  return decide(call, ctx);
}
