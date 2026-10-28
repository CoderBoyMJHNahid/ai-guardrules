import { describe, expect, it } from 'vitest';
import type { Decision, Dialect } from '../src/guard/types.js';
import { fileCall, run, shellCall, winCtx } from './helpers.js';

function decideWin(command: string, dialect: Dialect, preset: 'strict' | 'standard' = 'strict') {
  const ctx = winCtx(preset);
  return run(ctx, shellCall(ctx.root, command, dialect)).verdict;
}

type Row = [string, Dialect, Decision, string?];
const rows: Row[] = [
  ['Set-Location C:\\Windows', 'powershell', 'deny', 'boundary'],
  ['cd C:\\Windows', 'cmd', 'deny', 'boundary'],
  ['cd /d D:\\data', 'cmd', 'deny', 'boundary'],
  ['Get-Content C:\\Windows\\win.ini', 'powershell', 'deny', 'boundary'],
  ['type C:\\Users\\me\\.ssh\\id_rsa', 'cmd', 'deny'],
  ['Get-Content ..\\other\\x.txt', 'powershell', 'deny', 'boundary'],
  ['Get-Content \\\\server\\share\\x', 'powershell', 'deny', 'boundary'],
  ['type \\\\?\\C:\\Windows\\win.ini', 'cmd', 'deny', 'boundary'],
  ['type C:\\proj\\src\\a.ts', 'cmd', 'ask', 'commands'],
  ['type src\\a.ts', 'cmd', 'ask', 'commands'],
  ['type .ENV', 'cmd', 'deny', 'secrets'],
  ['type C:\\PROJ\\.env', 'cmd', 'deny', 'secrets'],
  ['type .env::$DATA', 'cmd', 'deny', 'secrets'],
  ['type .env.', 'cmd', 'deny', 'secrets'],
  ['Get-Content "$env:USERPROFILE\\.aws\\credentials"', 'powershell', 'deny'],
  ['type %USERPROFILE%\\x', 'cmd', 'deny', 'boundary'],
  ['Remove-Item src\\a.ts', 'powershell', 'deny', 'fileDelete'],
  ['del C:\\proj\\existing.txt', 'cmd', 'deny', 'fileDelete'],
  ['echo hi > NUL', 'cmd', 'ask', 'commands'],
  ['echo hi > C:\\Windows\\x.txt', 'cmd', 'deny', 'boundary'],
  ['echo hi > COM1', 'cmd', 'deny'],
  ['git push', 'cmd', 'deny', 'git'],
  ['git status', 'cmd', 'allow'],
];

describe('windows path semantics (injected path.win32)', () => {
  for (const [command, dialect, decision, guard] of rows) {
    it(`${dialect}: ${command}`, () => {
      const v = decideWin(command, dialect);
      expect(v.decision, `${v.guard}: ${v.message}`).toBe(decision);
      if (guard) expect(v.guard).toBe(guard);
    });
  }

  it('standard preset only blocks hard guards', () => {
    expect(decideWin('del x.txt', 'cmd', 'standard').decision).toBe('allow');
    expect(decideWin('rd /s /q C:\\', 'cmd', 'standard').decision).toBe('deny');
    expect(decideWin('format C:', 'cmd', 'standard').decision).toBe('deny');
    expect(decideWin('type .env', 'cmd', 'standard').decision).toBe('deny');
  });

  it('file tools use windows paths', () => {
    const ctx = winCtx();
    expect(run(ctx, fileCall(ctx.root, 'read', 'C:\\Windows\\win.ini', 'Read')).verdict.guard).toBe('boundary');
    expect(run(ctx, fileCall(ctx.root, 'read', 'C:\\PROJ\\SRC\\a.ts', 'Read')).verdict.decision).toBe('allow');
    expect(run(ctx, fileCall(ctx.root, 'read', 'C:\\proj\\.ENV', 'Read')).verdict.guard).toBe('secrets');
    expect(run(ctx, fileCall(ctx.root, 'write', 'C:\\proj\\new.txt')).verdict.guard).toBe('newFiles');
    expect(run(ctx, fileCall(ctx.root, 'write', 'C:\\proj\\claude.md', 'Write')).verdict.decision).not.toBe('allow');
  });
});

describe('windows 8.3 short names (RUNNER~1 vs runneradmin)', () => {
  const LONG = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\proj';
  const SHORT = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\proj';
  const toLong = (p: string): string => p.replace(/RUNNER~1/gi, 'runneradmin');

  /** Like the native realpath on Windows: short names come back expanded. */
  function ctxWithRoot(root: string) {
    const files = ['.env', 'existing.txt', 'src\\a.ts'];
    const existing = [SHORT, LONG, ...files.flatMap((f) => [`${SHORT}\\${f}`, `${LONG}\\${f}`])];
    const base = winCtx('strict', existing);
    return { ...base, root, env: { ...base.env, realpath: toLong } };
  }

  it('a root canonicalized the same way as resolved paths is not a boundary violation', () => {
    const ctx = ctxWithRoot(toLong(SHORT));
    expect(run(ctx, shellCall(ctx.root, 'type .env', 'cmd')).verdict.guard).toBe('secrets');
    expect(run(ctx, shellCall(ctx.root, 'Remove-Item src\\a.ts', 'powershell')).verdict.guard).toBe('fileDelete');
    expect(run(ctx, shellCall(ctx.root, 'git status', 'cmd')).verdict.decision).toBe('allow');
    expect(run(ctx, shellCall(ctx.root, 'type src\\a.ts', 'cmd')).verdict).toMatchObject({ decision: 'ask', guard: 'commands' });
  });

  it('a root left in short form is what produced the false boundary block', () => {
    const ctx = ctxWithRoot(SHORT);
    expect(run(ctx, shellCall(ctx.root, 'git status', 'cmd')).verdict.guard).toBe('boundary');
  });
});
