import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runGuard } from '../src/core/runGuard.js';
import { isBlocked, samplePayload } from '../src/core/samples.js';
import { canonicalPath } from '../src/guard/paths.js';
import { CLI, cli } from './harness.js';

/** End-to-end: the built CLI against a real temp project, the way a user runs it. */

let root: string;
const rel = (...p: string[]) => path.join(root, ...p);
const read = (...p: string[]) => fs.readFileSync(rel(...p), 'utf8');
const has = (...p: string[]) => fs.existsSync(rel(...p));

function put(file: string, content: string): void {
  fs.mkdirSync(path.dirname(rel(file)), { recursive: true });
  fs.writeFileSync(rel(file), content);
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(f, base));
    else out.push(path.relative(base, f).split(path.sep).join('/'));
  }
  return out.sort();
}

function snapshot(): Record<string, string> {
  return Object.fromEntries(listFiles(root).map((f) => [f, read(...f.split('/'))]));
}

function unlockAll(dir: string): void {
  for (const f of listFiles(dir)) fs.chmodSync(path.join(dir, ...f.split('/')), 0o644);
}

beforeEach(() => {
  root = canonicalPath(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-rules-e2e-')));
  put('package.json', '{"name":"t"}\n');
  put('.env', 'SECRET=1\n');
  put('src/a.ts', 'export {}\n');
});
afterEach(() => {
  try {
    unlockAll(root);
  } catch {
    /* ignore */
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the built CLI', () => {
  it('prints help and a version', () => {
    const h = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    expect(h.stdout).toContain('init');
    expect(h.stdout).toContain('doctor');
    const v = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' });
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('refuses to run commands before init', () => {
    const r = cli(root, 'policy', 'show');
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/init/);
    expect(cli(root, 'status').out).toMatch(/not installed/);
  });
});

describe('init -> refresh -> remove', () => {
  const USER_FILES: Record<string, string> = {
    'CLAUDE.md': '# Mine\r\n\r\nhello\r\n',
    '.claude/settings.json': '{\n  // mine\n  "model": "x",\n  "hooks": {"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo mine"}]}]}\n}\n',
    '.codex/config.toml': 'model = "o3"\n',
    '.gitignore': 'node_modules\n',
    'AGENTS.md': '# Agents\n\nBe kind.\n',
  };

  it('installs everything, is a no-op the second time, and removes cleanly with user files restored byte for byte', () => {
    for (const [f, c] of Object.entries(USER_FILES)) put(f, c);
    const before = snapshot();

    const first = cli(root, 'init', '--all', '-y');
    expect(first.code, first.out).toBe(0);
    expect(first.out).toContain('Self-test passed');
    for (const f of ['.ai-rules/guard.mjs', '.ai-rules/policy.json', '.ai-rules/lock.json', '.cursor/hooks.json', '.gemini/settings.json', '.devin/hooks.json', '.codex/hooks.json']) expect(has(...f.split('/')), f).toBe(true);

    // User content survived next to ours.
    expect(read('CLAUDE.md')).toContain('hello');
    expect(read('CLAUDE.md')).not.toMatch(/[^\r]\n/); // CRLF kept
    expect(read('.claude', 'settings.json')).toContain('// mine');
    expect(read('.claude', 'settings.json')).toContain('echo mine');
    expect(read('.claude', 'settings.json')).toContain('.ai-rules/guard.mjs');
    expect(read('.codex', 'config.toml')).toContain('model = "o3"');
    expect(read('AGENTS.md')).toContain('Be kind.');

    const afterFirst = snapshot();
    const second = cli(root, 'init', '--all', '-y');
    expect(second.code, second.out).toBe(0);
    expect(second.out).toMatch(/already up to date/);
    const afterSecond = snapshot();
    // Ignore only the backup directory (written once, never again).
    const strip = (s: Record<string, string>) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('.ai-rules/backups/')));
    expect(strip(afterSecond)).toEqual(strip(afterFirst));

    const rm = cli(root, 'remove', '-y');
    expect(rm.code, rm.out).toBe(0);
    unlockAll(root);
    const after = snapshot();
    expect(Object.keys(after).filter((k) => k.startsWith('.ai-rules/'))).toEqual([]);
    for (const [f, c] of Object.entries(before)) {
      // JSON may be re-indented where we inserted our entry, but comments and content must survive.
      if (f === '.claude/settings.json') {
        expect(after[f]).toContain('// mine');
        expect(JSON.parse((after[f] as string).replace(/^\s*\/\/.*$/gm, ''))).toEqual(JSON.parse(c.replace(/^\s*\/\/.*$/gm, '')));
      } else expect(after[f], f).toBe(c);
    }
    // Files we created are gone; nothing else was added.
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it('--dry-run writes nothing', () => {
    const before = snapshot();
    const r = cli(root, 'init', '--all', '-y', '--dry-run');
    expect(r.code, r.out).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it('refuses to overwrite a settings file that is not valid JSON', () => {
    put('.claude/settings.json', '{ this is not json');
    const r = cli(root, 'init', '--tools', 'claude', '-y');
    expect(r.code).not.toBe(0);
    expect(read('.claude', 'settings.json')).toBe('{ this is not json');
  });

  it('installs only the tools asked for', () => {
    const r = cli(root, 'init', '--tools', 'claude,agents', '-y');
    expect(r.code, r.out).toBe(0);
    expect(has('.claude', 'settings.json')).toBe(true);
    expect(has('.cursor')).toBe(false);
    expect(has('.gemini')).toBe(false);
  });

  it('standard preset only guards secrets and destructive actions', () => {
    expect(cli(root, 'init', '--tools', 'claude', '--preset', 'standard', '-y').code).toBe(0);
    expect(cli(root, 'guard', 'test', 'npm test').out).toContain('ALLOW');
    expect(cli(root, 'guard', 'test', 'cat .env').out).toContain('DENY');
    expect(cli(root, 'guard', 'test', 'git push').out).toContain('ALLOW');
  });

  it('strict is the default', () => {
    expect(cli(root, 'init', '--tools', 'claude', '-y').code).toBe(0);
    expect(cli(root, 'policy', 'show').out).toContain('strict');
    expect(cli(root, 'guard', 'test', 'git push').out).toContain('DENY');
    expect(cli(root, 'guard', 'test', 'git status').out).toContain('ALLOW');
  });

  it('keeps hooks first when a user hook already exists and does not duplicate on refresh', () => {
    put('.claude/settings.json', '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo mine"}]}]}}\n');
    cli(root, 'init', '--tools', 'claude', '-y');
    cli(root, 'update');
    cli(root, 'update');
    const json = JSON.parse(read('.claude', 'settings.json')) as { hooks: { PreToolUse: unknown[] } };
    const ours = json.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('.ai-rules/guard.mjs'));
    expect(ours.length).toBe(1);
    expect(json.hooks.PreToolUse.length).toBe(2);
  });
});

describe('everyday commands on an installed project', () => {
  beforeEach(() => {
    const r = cli(root, 'init', '--tools', 'claude,cursor,gemini,windsurf,codex,agents', '-y');
    expect(r.code, r.out).toBe(0);
  });

  const guard = () => rel('.ai-rules', 'guard.mjs');
  const payload = (kind: 'shell' | 'read' | 'write', value: string, agent: 'claude' | 'cursor' = 'claude') => runGuard(guard(), agent, samplePayload(agent, kind, value, root), root);

  it('status and doctor are healthy', () => {
    expect(cli(root, 'status').out).toContain('locked and intact');
    const d = cli(root, 'doctor', '--ci');
    expect(d.code, d.out).toBe(0);
    expect(d.out).toContain('All critical checks passed');
  });

  it('the installed hook really blocks over a real process boundary', () => {
    expect(isBlocked('claude', payload('shell', 'git push origin main'))).toBe(true);
    expect(isBlocked('cursor', payload('shell', 'cat .env', 'cursor'))).toBe(true);
    expect(isBlocked('claude', payload('shell', 'git status'))).toBe(false);
  });

  it('allow / grants list / grants revoke change what the hook does', () => {
    const asks = () => JSON.stringify(payload('shell', 'npm test'));
    expect(asks()).toContain('ask');
    expect(cli(root, 'allow', 'npm test', '--for', '1h').code).toBe(0);
    expect(asks()).not.toContain('"ask"');
    expect(cli(root, 'grants', 'list').out).toContain('npm test');
    cli(root, 'grants', 'revoke', '--all');
    expect(asks()).toContain('ask');
  });

  it('rule add writes to the agent files and survives update; rule remove takes it out', () => {
    expect(cli(root, 'rule', 'add', 'Use pnpm, never npm').code).toBe(0);
    for (const f of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) expect(read(f), f).toContain('Use pnpm, never npm');
    expect(cli(root, 'update').code).toBe(0);
    expect(read('AGENTS.md')).toContain('Use pnpm, never npm');
    expect(cli(root, 'rule', 'list').out).toContain('Use pnpm');
    expect(cli(root, 'rule', 'remove', '1').code).toBe(0);
    expect(read('AGENTS.md')).not.toContain('Use pnpm');
    expect(cli(root, 'doctor', '--ci').code).toBe(0);
  });

  it('custom guards and hooks survive update and are removed by remove unless --keep-custom', () => {
    cli(root, 'guard', 'add', '--id', 'no-curl', '--command', 'curl', '--message', 'no network');
    cli(root, 'hook', 'add', '--id', 'noop', '--run', 'node -e "process.exit(0)"');
    expect(cli(root, 'update').code).toBe(0);
    expect(cli(root, 'guard', 'list').out).toContain('no-curl');
    expect(cli(root, 'hook', 'list').out).toContain('noop');
    expect(cli(root, 'guard', 'test', 'curl x.com').out).toContain('DENY');
    expect(cli(root, 'remove', '-y', '--keep-custom').code).toBe(0);
    unlockAll(root);
    expect(has('.ai-rules', 'custom', 'guards.json')).toBe(true);
    expect(has('.ai-rules', 'guard.mjs')).toBe(false);
  });

  it('policy set changes behaviour and hard guards cannot be relaxed', () => {
    expect(cli(root, 'policy', 'set', 'commands', 'allow').code).toBe(0);
    expect(JSON.stringify(payload('shell', 'npm test'))).not.toContain('"ask"');
    expect(cli(root, 'policy', 'set', 'secrets', 'off').code).not.toBe(0);
    expect(cli(root, 'doctor', '--ci').code).toBe(0);
  });

  describe('tampering', () => {
    it('editing guard.mjs makes the guard block everything until the user relocks', () => {
      const g = guard();
      fs.chmodSync(g, 0o644);
      fs.appendFileSync(g, '\n// agent was here\n');
      const r = payload('shell', 'git status');
      expect(isBlocked('claude', r), JSON.stringify(r)).toBe(true);
      expect(cli(root, 'status').out).toContain('MODIFIED');
      expect(cli(root, 'doctor', '--ci').code).not.toBe(0);
      // The user can always recover: update restores the shipped guard.
      expect(cli(root, 'update').code).toBe(0);
      expect(isBlocked('claude', payload('shell', 'git status'))).toBe(false);
    });

    it('editing policy.json to allow everything is detected', () => {
      const f = rel('.ai-rules', 'policy.json');
      fs.chmodSync(f, 0o644);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/"deny"/g, '"allow"'));
      expect(isBlocked('claude', payload('shell', 'git push'))).toBe(true);
      expect(isBlocked('claude', payload('shell', 'git status'))).toBe(true);
    });

    it('a hand-made custom file is not trusted until the user runs lock', () => {
      put('.ai-rules/custom/guards.json', '{"guards":[]}');
      expect(isBlocked('claude', payload('shell', 'git status'))).toBe(true);
      expect(cli(root, 'lock').code).toBe(0);
      expect(isBlocked('claude', payload('shell', 'git status'))).toBe(false);
    });

    it('deleting the lock blocks everything', () => {
      const f = rel('.ai-rules', 'lock.json');
      fs.chmodSync(f, 0o644);
      fs.rmSync(f);
      expect(isBlocked('claude', payload('shell', 'git status'))).toBe(true);
    });

    it('the guard files are read-only on disk', () => {
      expect(() => fs.appendFileSync(guard(), 'x')).toThrow();
    });

    it('editing guard.mjs with CRLF line endings is still accepted as the same file (git autocrlf)', () => {
      const g = guard();
      fs.chmodSync(g, 0o644);
      fs.writeFileSync(g, fs.readFileSync(g, 'utf8').replace(/\n/g, '\r\n'));
      expect(isBlocked('claude', payload('shell', 'git status'))).toBe(false);
    });
  });
});
