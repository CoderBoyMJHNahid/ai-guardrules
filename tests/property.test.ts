import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeBlock, upsertBlock } from '../src/core/markdown.js';
import { expandBraces, matchPathGlob } from '../src/guard/glob.js';
import type { Dialect } from '../src/guard/types.js';
import { ctxFor, makeProject, run, shellCall, type Project } from './helpers.js';

let proj: Project;
beforeAll(() => {
  proj = makeProject();
});
afterAll(() => proj.cleanup());

const strictCtx = () => ctxFor(proj.root, 'strict');
const decideStrict = (command: string, dialect: Dialect = 'bash') => {
  const ctx = strictCtx();
  return run(ctx, shellCall(ctx.root, command, dialect)).verdict;
};

const TOKENS = ['git', 'status', 'rm', '-rf', '.env', 'cat', '|', '&&', ';', '$(', ')', '`', '"', "'", '\\', '>', '<', '*', '?', '{', '}', '[', ']', ' ', '\n', 'sudo', 'sh', '-c', 'eval', 'x', '..', '/', '~', '$X', '%X%', '&', '(', '#', '!', '=', 'psql', 'DROP', 'TABLE'];
const noisyCommand = fc.array(fc.constantFrom(...TOKENS), { minLength: 0, maxLength: 14 }).map((t) => t.join(' '));
const rawString = fc.string({ maxLength: 60 });
const DIALECTS: Dialect[] = ['bash', 'powershell', 'cmd'];

describe('the guard never crashes and always returns a valid decision', () => {
  for (const dialect of DIALECTS) {
    it(`${dialect}: arbitrary text`, () => {
      fc.assert(
        fc.property(fc.oneof(noisyCommand, rawString), (cmd) => {
          if (cmd.trim() === '') return true;
          const v = decideStrict(cmd, dialect);
          return v.decision === 'allow' || v.decision === 'ask' || v.decision === 'deny';
        }),
        { numRuns: 400 },
      );
    });
  }
});

/**
 * True when the text starts with git once empty leading segments (stray separators,
 * grouping characters and comment lines) are ignored. The guard skips those, so
 * `; git status` is just `git status`.
 */
const startsWithGit = (cmd: string): boolean => /^(?:[\s!({;&|]|#[^\n]*)*(time\s+|command\s+|builtin\s+)*git\s/.test(cmd);

describe('strict preset: an unprompted allow only happens for read-only git', () => {
  it('holds for arbitrary text', () => {
    fc.assert(
      fc.property(fc.oneof(noisyCommand, rawString), (cmd) => {
        const v = decideStrict(cmd, 'bash');
        if (v.decision !== 'allow') return true;
        return startsWithGit(cmd);
      }),
      { numRuns: 800 },
    );
  });

  it('allows read-only git behind empty leading segments (regression for a flaky counterexample)', () => {
    for (const cmd of ['; git status', '& git status', '# note\ngit status']) {
      expect(startsWithGit(cmd)).toBe(true);
      expect(decideStrict(cmd, 'bash').decision).not.toBe('deny');
    }
    expect(decideStrict('; git status', 'bash').decision).toBe('allow');
    expect(startsWithGit('; rm x')).toBe(false);
    expect(startsWithGit('echo hi; git status')).toBe(false);
  });

  it('holds for chains built from git and other tokens', () => {
    const part = fc.constantFrom('git status', 'git log', 'git diff', 'git push', 'ls', 'rm x', 'cat .env', 'echo hi', 'git show HEAD');
    const joiner = fc.constantFrom(' && ', '; ', ' | ', ' || ', '\n', ' & ');
    fc.assert(
      fc.property(fc.array(fc.tuple(part, joiner), { minLength: 1, maxLength: 4 }), (parts) => {
        const cmd = parts.map(([p, j]) => p + j).join('') + 'git status';
        const v = decideStrict(cmd);
        const onlyReadOnlyGit = cmd.split(/ && |; | \| | \|\| |\n| & /).every((c) => /^git (status|log|diff|show)\b/.test(c.trim()));
        if (v.decision === 'allow') return onlyReadOnlyGit;
        return true;
      }),
      { numRuns: 400 },
    );
  });
});

const ATTACKS_BASH = ['rm x', 'cat .env', 'git push', 'psql -c "DROP TABLE t"', 'cat /etc/passwd', 'unlink existing.txt', 'git add .'];
/** Quote a string for single quotes the way a real shell user would. */
const q = (c: string): string => c.replace(/'/g, "'\\''");
const WRAPPERS: Array<(c: string) => string> = [
  (c) => `sudo ${c}`,
  (c) => `env A=1 ${c}`,
  (c) => `nohup ${c}`,
  (c) => `time ${c}`,
  (c) => `command ${c}`,
  (c) => `timeout 9 ${c}`,
  (c) => `echo a && ${c}`,
  (c) => `echo a; ${c}`,
  (c) => `false || ${c}`,
  (c) => `( ${c} )`,
  (c) => `{ ${c}; }`,
  (c) => `echo $( ${c} )`,
  (c) => `if true; then ${c}; fi`,
  (c) => `bash -c '${q(c)}'`,
  (c) => `echo x | xargs ${c}`,
  (c) => `${c} &`,
  (c) => `${c} # note`,
  (c) => `eval '${q(c)}'`,
];

describe('wrappers never hide an attack', () => {
  it('any stack of 0-3 wrappers around an attack is still denied', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ATTACKS_BASH), fc.array(fc.nat(WRAPPERS.length - 1), { maxLength: 3 }), (base, picks) => {
        // sudo/env/nohup/time/command/timeout/xargs cannot prefix a compound command: that is a bash syntax error.
        const PREFIX = new Set([0, 1, 2, 3, 4, 5, 14]);
        let cmd = base;
        for (const i of picks) {
          if (PREFIX.has(i) && /^(\(|\{|if )/.test(cmd)) return true;
          cmd = (WRAPPERS[i] as (c: string) => string)(cmd);
        }
        return decideStrict(cmd).decision === 'deny';
      }),
      { numRuns: 600 },
    );
  });
});

describe('quoting tricks never hide a command name or secret path', () => {
  const noise = fc.constantFrom('', '""', "''", '\\');
  const insert = (word: string, noises: string[]): string => word.split('').map((ch, i) => ch + (i < word.length - 1 ? (noises[i % noises.length] ?? '') : '')).join('');

  it('rm with quote noise between letters is still a delete', () => {
    fc.assert(
      fc.property(fc.array(noise, { minLength: 1, maxLength: 3 }), (noises) => decideStrict(`${insert('rm', noises)} existing.txt`).decision === 'deny'),
      { numRuns: 100 },
    );
  });

  it('.env with quote noise is still a secret', () => {
    fc.assert(
      fc.property(fc.array(noise, { minLength: 1, maxLength: 4 }), (noises) => {
        const v = decideStrict(`cat ${insert('.env', noises)}`);
        return v.decision === 'deny' && v.guard === 'secrets';
      }),
      { numRuns: 100 },
    );
  });

  it('git push with quote noise is still blocked', () => {
    fc.assert(
      fc.property(fc.array(noise, { minLength: 1, maxLength: 3 }), (noises) => decideStrict(`${insert('git', noises)} ${insert('push', noises)}`).decision === 'deny'),
      { numRuns: 100 },
    );
  });
});

describe('paths', () => {
  it('any relative path that climbs out of the project is denied', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.array(fc.constantFrom('a', 'b', 'src'), { maxLength: 3 }), (ups, mid) => {
        const p = ['..', ...Array(ups - 1).fill('..'), ...mid, 'file'].join('/');
        const v = decideStrict(`cat ${p}`);
        return v.decision === 'deny';
      }),
      { numRuns: 100 },
    );
  });

  it('paths that wander but stay inside are not boundary violations', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('src', 'dir', 'x'), { minLength: 1, maxLength: 3 }), (dirs) => {
        const p = [...dirs.flatMap((d) => [d, '..']), 'src/a.ts'].join('/');
        const v = decideStrict(`cat ${p}`);
        return v.guard !== 'boundary';
      }),
      { numRuns: 100 },
    );
  });
});

describe('markdown block merge', () => {
  const body = fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim() !== '' && !s.includes('ai-guardrules'));
  const doc = fc.array(fc.string({ maxLength: 30 }).filter((s) => !s.includes('ai-guardrules')), { maxLength: 6 }).map((l) => l.join('\n'));

  it('is idempotent', () => {
    fc.assert(
      fc.property(doc, body, (d, b) => {
        const once = upsertBlock(d, b);
        return upsertBlock(once, b) === once;
      }),
      { numRuns: 200 },
    );
  });

  it('replaces the block when the body changes and keeps surrounding text', () => {
    fc.assert(
      fc.property(doc, body, body, (d, b1, b2) => {
        const out = upsertBlock(upsertBlock(d, b1), b2);
        return out === upsertBlock(d, b2) || (out.includes(b2.trim()) && out.startsWith(d));
      }),
      { numRuns: 200 },
    );
  });

  it('removing the block leaves the original text', () => {
    fc.assert(
      fc.property(doc, body, (d, b) => {
        const removed = removeBlock(upsertBlock(d, b));
        if (d.trim() === '') return removed === null;
        return removed !== null && removed.trim() === d.trim();
      }),
      { numRuns: 200 },
    );
  });
});

describe('glob helpers', () => {
  it('brace expansion is bounded and contains every simple alternative', () => {
    fc.assert(
      fc.property(fc.array(fc.stringMatching(/^[a-z]{1,3}$/), { minLength: 2, maxLength: 5 }), (alts) => {
        const out = expandBraces(`{${alts.join(',')}}`);
        return alts.every((a) => out.includes(a)) && out.length <= 64;
      }),
      { numRuns: 100 },
    );
  });

  it('a nested brace bomb stays under the cap', () => {
    expect(expandBraces('{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}{a,b}').length).toBeLessThanOrEqual(64);
  });

  it('character classes work in path globs', () => {
    expect(matchPathGlob('.[e]nv', '.env')).toBe(true);
    expect(matchPathGlob('.[!e]nv', '.env')).toBe(false);
  });
});

it('keeps vitest happy when no property ran', () => expect(true).toBe(true));
