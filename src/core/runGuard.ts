import { spawnSync } from 'node:child_process';

export interface GuardRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a guard script the way an agent would: payload on stdin, project root as cwd. */
export function runGuard(guardPath: string, agent: string, payload: unknown, cwd: string, timeoutMs = 20_000): GuardRun {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [guardPath, `--tool=${agent}`], { cwd, input, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { code: r.status ?? (r.error || r.signal ? 2 : 1), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
