import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { samplePayload } from '../src/core/samples.js';
import { validateGuard, validateHook } from '../src/guard/custom.js';
import { evaluateSafe } from '../src/guard/evaluate.js';
import { parseDuration } from '../src/guard/grants.js';
import { cli, installProject, type Installed } from './harness.js';

let p: Installed;
beforeEach(() => {
  p = installProject('strict');
});
afterEach(() => p.cleanup());

const dir = () => path.join(p.root, '.ai-guardrules');
const shell = (command: string) => evaluateSafe('claude', samplePayload('claude', 'shell', command, p.root), dir()).outcome;
const node = (code: string) => `node -e "${code.replace(/"/g, '\\"')}"`;
const addHook = (id: string, run: string, extra: string[] = []) => {
  const r = cli(p.root, 'hook', 'add', '--id', id, '--run', run, ...extra);
  expect(r.code, r.out).toBe(0);
};

describe('validation', () => {
  it('rejects malformed guards', () => {
    expect(() => validateGuard({})).toThrow();
    expect(() => validateGuard({ id: 'a b', on: 'shell', decision: 'deny', command: 'x', message: 'm' })).toThrow();
    expect(() => validateGuard({ id: 'a', on: 'shell', decision: 'maybe', command: 'x', message: 'm' })).toThrow();
    expect(() => validateGuard({ id: 'a', on: 'shell', decision: 'deny', message: 'm' })).toThrow(/at least one/);
    expect(() => validateGuard({ id: 'a', on: 'shell', decision: 'deny', command: 'x' })).toThrow(/message/);
    expect(validateGuard({ id: 'a', on: 'shell', decision: 'deny', command: 'x', message: 'm' }).id).toBe('a');
  });

  it('rejects malformed hooks', () => {
    expect(() => validateHook({ id: 'h', event: 'nope', run: 'x' })).toThrow();
    expect(() => validateHook({ id: 'h', event: 'any', run: '' })).toThrow();
    expect(() => validateHook({ id: 'h', event: 'any', run: 'x', timeoutMs: 5 })).toThrow();
    expect(validateHook({ id: 'h', event: 'any', run: 'x' }).id).toBe('h');
  });

  it('parses durations', () => {
    expect(parseDuration('30m')).toBe(30 * 60_000);
    expect(parseDuration('2h')).toBe(2 * 3_600_000);
    expect(parseDuration('1d')).toBe(86_400_000);
    expect(() => parseDuration('soon')).toThrow();
  });
});

describe('custom guards', () => {
  it('a deny guard blocks what the preset would only ask about', () => {
    expect(shell('npm publish').decision).toBe('ask');
    expect(cli(p.root, 'guard', 'add', '--id', 'no-publish', '--command', 'npm', '--match', 'publish*', '--decision', 'deny', '--message', 'Never publish').code).toBe(0);
    const o = shell('npm publish');
    expect(o.decision).toBe('deny');
    expect(o.message).toContain('Never publish');
  });

  it('an allow guard can relax an ask but never a deny', () => {
    expect(shell('npm test').decision).toBe('ask');
    cli(p.root, 'guard', 'add', '--id', 'ok-test', '--command', 'npm', '--match', 'test*', '--decision', 'allow', '--message', 'tests are fine');
    cli(p.root, 'guard', 'add', '--id', 'ok-push', '--command', 'git', '--match', 'push*', '--decision', 'allow', '--message', 'push is fine');
    cli(p.root, 'guard', 'add', '--id', 'ok-rm', '--command', 'rm', '--decision', 'allow', '--message', 'rm is fine');
    expect(shell('npm test').decision).toBe('allow');
    expect(shell('git push origin main').decision).toBe('deny');
    expect(shell('rm existing.txt').decision).toBe('deny');
    expect(shell('npm test && git push').decision).toBe('deny');
  });

  it('path guards protect files from edits', () => {
    cli(p.root, 'guard', 'add', '--id', 'lockfile', '--on', 'write', '--path', 'package.json', '--decision', 'deny', '--message', 'Do not touch package.json');
    const w = evaluateSafe('claude', samplePayload('claude', 'write', path.join(p.root, 'package.json'), p.root), dir()).outcome;
    expect(w.decision).toBe('deny');
    const other = evaluateSafe('claude', samplePayload('claude', 'write', path.join(p.root, 'existing.txt'), p.root), dir()).outcome;
    expect(other.decision).not.toBe('deny');
  });

  it('guard test and remove work, and a duplicate id is refused', () => {
    cli(p.root, 'guard', 'add', '--id', 'g1', '--command', 'curl', '--decision', 'ask', '--message', 'network');
    expect(cli(p.root, 'guard', 'add', '--id', 'g1', '--command', 'curl', '--message', 'again').code).not.toBe(0);
    expect(cli(p.root, 'guard', 'list').out).toContain('g1');
    expect(cli(p.root, 'guard', 'test', 'curl example.com').out).toMatch(/ASK|DENY/);
    expect(cli(p.root, 'guard', 'remove', 'g1').code).toBe(0);
    expect(cli(p.root, 'guard', 'remove', 'g1').code).not.toBe(0);
    expect(cli(p.root, 'doctor', '--ci').code).toBe(0);
  });
});

describe('custom hooks fail closed and can only be stricter', () => {
  it('exit 0 with no output changes nothing', () => {
    addHook('quiet', node('process.exit(0)'));
    expect(shell('git status').decision).toBe('allow');
  });

  it('exit 2 blocks and shows the stderr reason', () => {
    addHook('block', node("console.error('nope from hook');process.exit(2)"));
    const o = shell('git status');
    expect(o.decision).toBe('deny');
    expect(o.message).toContain('nope from hook');
  });

  it('any other non-zero exit blocks', () => {
    addHook('crash', node('process.exit(1)'));
    expect(shell('git status').decision).toBe('deny');
  });

  it('a timeout blocks', () => {
    addHook('slow', node('setTimeout(()=>{},10000)'), ['--timeout', '300']);
    expect(shell('git status').decision).toBe('deny');
  });

  it('output that is not JSON blocks', () => {
    addHook('garbage', node("console.log('hello')"));
    expect(shell('git status').decision).toBe('deny');
  });

  it('a missing command blocks', () => {
    addHook('missing', 'definitely-not-a-real-program-xyz');
    expect(shell('git status').decision).toBe('deny');
  });

  it('JSON ask turns an allow into an ask', () => {
    addHook('asker', node("console.log(JSON.stringify({decision:'ask',reason:'check with a human'}))"));
    const o = shell('git status');
    expect(o.decision).toBe('ask');
    expect(o.message).toContain('check with a human');
  });

  it('JSON allow cannot relax a deny', () => {
    addHook('liberal', node("console.log(JSON.stringify({decision:'allow'}))"));
    expect(shell('git push').decision).toBe('deny');
    expect(shell('cat .env').decision).toBe('deny');
    expect(shell('git status').decision).toBe('allow');
  });

  it('receives the action as JSON on stdin', () => {
    const script = "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.exit(j.command==='git log'&&j.kind==='shell'?2:0)})";
    addHook('inspect', node(script));
    expect(shell('git log').decision).toBe('deny');
    expect(shell('git status').decision).toBe('allow');
  });

  it('only runs for its event', () => {
    addHook('writes-only', node('process.exit(2)'), ['--event', 'before-write']);
    expect(shell('git status').decision).toBe('allow');
    const w = evaluateSafe('claude', samplePayload('claude', 'write', path.join(p.root, 'existing.txt'), p.root), dir()).outcome;
    expect(w.decision).toBe('deny');
  });

  it('hook test and remove work', () => {
    addHook('t', node('process.exit(0)'));
    expect(cli(p.root, 'hook', 'test', 't', '--command', 'ls').out).toContain('would not object');
    expect(cli(p.root, 'hook', 'list').out).toContain('t');
    expect(cli(p.root, 'hook', 'remove', 't').code).toBe(0);
    expect(cli(p.root, 'doctor', '--ci').code).toBe(0);
  });
});

describe('grants', () => {
  it('a --once grant works exactly once', () => {
    expect(shell('npm test').decision).toBe('ask');
    expect(cli(p.root, 'allow', 'npm test', '--once').code).toBe(0);
    expect(shell('npm test').decision).toBe('allow');
    expect(shell('npm test').decision).toBe('ask');
  });

  it('a --once grant is not consumed when the final decision is not allow', () => {
    cli(p.root, 'allow', 'npm test', '--once');
    expect(shell('npm test && git push').decision).toBe('deny');
    expect(shell('npm test').decision).toBe('allow');
  });

  it('a timed grant expires', () => {
    cli(p.root, 'allow', 'npm test', '--for', '30m');
    const now = Date.now();
    const at = (t: number) => evaluateSafe('claude', samplePayload('claude', 'shell', 'npm test', p.root), dir(), { now: t }).outcome.decision;
    expect(at(now + 60_000)).toBe('allow');
    expect(at(now + 31 * 60_000)).toBe('ask');
  });

  it('a wildcard grant does not cover chained commands', () => {
    cli(p.root, 'allow', 'npm test*');
    expect(shell('npm test --silent').decision).toBe('allow');
    expect(shell('npm test; npm publish').decision).toBe('ask');
  });

  it('cannot approve a fixed rule', () => {
    for (const cmd of ['cat .env', 'rm -rf /', 'psql -c "DROP TABLE t"']) {
      const r = cli(p.root, 'allow', cmd);
      expect(r.out, cmd).toMatch(/will not help/);
      expect(shell(cmd).decision, cmd).toBe('deny');
    }
  });

  it('a grant for a blocked git command is a deliberate user decision', () => {
    expect(shell('git push').decision).toBe('deny');
    cli(p.root, 'allow', 'git push', '--once');
    expect(shell('git push').decision).toBe('allow');
    expect(shell('git push').decision).toBe('deny');
  });

  it('create grants let agents add matching files', () => {
    const target = path.join(p.root, 'docs', 'new.md');
    const pay = () => evaluateSafe('claude', samplePayload('claude', 'write', target, p.root), dir()).outcome.decision;
    expect(pay()).toBe('ask');
    cli(p.root, 'allow-create', 'docs/**');
    expect(pay()).toBe('allow');
  });

  it('list and revoke', () => {
    cli(p.root, 'allow', 'npm test');
    const listed = cli(p.root, 'grants', 'list').out;
    const id = listed.split('\n').find((l) => l.includes('npm test'))?.trim().split(/\s+/)[0];
    expect(id).toBeTruthy();
    expect(cli(p.root, 'grants', 'revoke', id as string).code).toBe(0);
    expect(shell('npm test').decision).toBe('ask');
    cli(p.root, 'allow', 'npm test');
    expect(cli(p.root, 'grants', 'revoke', '--all').code).toBe(0);
    expect(shell('npm test').decision).toBe('ask');
  });

  it('an agent editing grants.json directly does not change the lock but grants stay data-only', () => {
    const f = path.join(dir(), 'grants.json');
    fs.writeFileSync(f, JSON.stringify({ grants: [{ id: 'x', kind: 'command', pattern: '*', createdAt: 1, expiresAt: null, once: false }] }));
    // A forged blanket grant still cannot beat the fixed rules.
    expect(shell('git push').decision).toBe('deny');
    expect(shell('cat .env').decision).toBe('deny');
  });
});

describe('policy', () => {
  it('policy set relaxes a grantable guard and refuses hard ones', () => {
    expect(shell('npm test').decision).toBe('ask');
    expect(cli(p.root, 'policy', 'set', 'commands', 'allow').code).toBe(0);
    expect(shell('npm test').decision).toBe('allow');
    expect(shell('git push').decision).toBe('deny');
    expect(cli(p.root, 'policy', 'set', 'secrets', 'allow').code).not.toBe(0);
    expect(cli(p.root, 'policy', 'set', 'databaseDelete', 'off').code).not.toBe(0);
    expect(cli(p.root, 'policy', 'set', 'nonsense', 'deny').code).not.toBe(0);
    expect(cli(p.root, 'policy', 'show').out).toContain('commands');
    expect(shell('cat .env').decision).toBe('deny');
  });
});
