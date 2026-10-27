import { describe, expect, it } from 'vitest';
import { JsonEditor, addUnique, isOurs, removeKnown, withOurs, withoutOurs } from '../src/adapters/shared.js';
import { detectEol, toEol } from '../src/core/fsutil.js';
import { JsonError, newJson, parseJsonc, setPath } from '../src/core/json.js';
import { END, MarkerError, START, hasBlock, removeBlock, upsertBlock } from '../src/core/markdown.js';
import { removeLinesBlock, upsertLinesBlock } from '../src/core/textblock.js';
import { T_END, T_START, hasTomlBlock, removeTomlBlock, upsertTomlBlock } from '../src/core/toml.js';

describe('markdown blocks', () => {
  it('creates a file with the block (and optional header)', () => {
    expect(upsertBlock(null, 'hello')).toBe(`${START}\nhello\n${END}\n`);
    expect(upsertBlock(null, 'hello', '---\nx: 1\n---\n')).toBe(`---\nx: 1\n---\n${START}\nhello\n${END}\n`);
  });

  it('appends to an existing file and leaves user text untouched', () => {
    const user = '# My rules\n\nBe nice.\n';
    const out = upsertBlock(user, 'hello');
    expect(out.startsWith(user)).toBe(true);
    expect(removeBlock(out)).toBe(user);
  });

  it('is idempotent and replaces in place', () => {
    const once = upsertBlock('# T\n', 'one');
    expect(upsertBlock(once, 'one')).toBe(once);
    const twice = upsertBlock(once, 'two');
    expect(twice).toContain('two');
    expect(twice).not.toContain('one');
    expect(twice.match(new RegExp(START, 'g'))?.length).toBe(1);
  });

  it('keeps CRLF files CRLF end to end', () => {
    const user = '# T\r\n\r\nText\r\n';
    const out = upsertBlock(user, 'a\nb');
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(removeBlock(out)).toBe(user);
  });

  it('keeps text before and after the block', () => {
    const out = upsertBlock('top\n', 'x') + 'bottom\n';
    expect(removeBlock(out)).toBe('top\nbottom\n');
  });

  it('returns null when only our block (and the header) is left', () => {
    expect(removeBlock(upsertBlock(null, 'x'))).toBeNull();
    expect(removeBlock(upsertBlock(null, 'x', '---\na: 1\n---\n'), '---\na: 1\n---\n')).toBeNull();
  });

  it('refuses broken or duplicated markers instead of guessing', () => {
    expect(() => upsertBlock(`${START}\nno end`, 'x')).toThrow(MarkerError);
    expect(() => upsertBlock(`${END}\n${START}\n`, 'x')).toThrow(MarkerError);
    expect(() => upsertBlock(`${START}\na\n${END}\n${START}\nb\n${END}\n`, 'x')).toThrow(MarkerError);
  });

  it('hasBlock', () => {
    expect(hasBlock(null)).toBe(false);
    expect(hasBlock('plain')).toBe(false);
    expect(hasBlock(upsertBlock(null, 'x'))).toBe(true);
  });
});

describe('toml block', () => {
  it('adds keys at the top and removes them again', () => {
    const user = 'model = "x"\n\n[profiles.a]\nfoo = 1\n';
    const { text, skipped } = upsertTomlBlock(user, [['approval_policy', '"on-request"']]);
    expect(skipped).toEqual([]);
    expect(text.startsWith(T_START)).toBe(true);
    expect(text).toContain(user);
    expect(removeTomlBlock(text)).toBe(user);
  });

  it('never overrides a key the user already set', () => {
    const user = 'approval_policy = "never"\n';
    const r = upsertTomlBlock(user, [['approval_policy', '"on-request"'], ['sandbox_mode', '"workspace-write"']]);
    expect(r.skipped).toEqual(['approval_policy']);
    expect(r.text).toContain('approval_policy = "never"');
    expect(r.text).toContain('sandbox_mode = "workspace-write"');
  });

  it('is idempotent', () => {
    const a = upsertTomlBlock(null, [['a', '1']]).text;
    expect(upsertTomlBlock(a, [['a', '1']]).text).toBe(a);
  });

  it('does not treat keys inside tables as top-level', () => {
    const user = '[x]\napproval_policy = "never"\n';
    const r = upsertTomlBlock(user, [['approval_policy', '"on-request"']]);
    expect(r.skipped).toEqual([]);
  });

  it('keeps CRLF', () => {
    const user = 'a = 1\r\n';
    const { text } = upsertTomlBlock(user, [['b', '2']]);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(removeTomlBlock(text)).toBe(user);
  });

  it('removing from a file that only had our block gives null', () => {
    expect(removeTomlBlock(upsertTomlBlock(null, [['a', '1']]).text)).toBeNull();
    expect(hasTomlBlock(upsertTomlBlock(null, [['a', '1']]).text)).toBe(true);
  });

  it('refuses an incomplete block', () => {
    expect(() => upsertTomlBlock(`${T_START}\na = 1\n`, [['b', '2']])).toThrow();
    expect(() => removeTomlBlock(`${T_END}\n${T_START}\n`)).toThrow();
  });
});

describe('line blocks (.gitignore, .gitattributes)', () => {
  it('appends, replaces and removes', () => {
    const user = 'node_modules\ndist\n';
    const a = upsertLinesBlock(user, ['x', 'y']);
    expect(a.startsWith(user)).toBe(true);
    expect(upsertLinesBlock(a, ['x', 'y'])).toBe(a);
    expect(upsertLinesBlock(a, ['z'])).not.toContain('y');
    expect(removeLinesBlock(a)).toBe(user);
  });

  it('works on empty and missing files', () => {
    expect(removeLinesBlock(upsertLinesBlock(null, ['x']))).toBeNull();
    expect(removeLinesBlock(upsertLinesBlock('', ['x']))).toBeNull();
  });

  it('keeps CRLF', () => {
    const user = 'a\r\nb\r\n';
    const a = upsertLinesBlock(user, ['x']);
    expect(a.replace(/\r\n/g, '')).not.toContain('\n');
    expect(removeLinesBlock(a)).toBe(user);
  });

  it('a file without a block is returned unchanged', () => {
    expect(removeLinesBlock('a\n')).toBe('a\n');
  });
});

describe('json editing', () => {
  const user = '{\n  // keep me\n  "a": 1,\n  "hooks": {\n    "X": [ { "run": "mine" } ]\n  }\n}\n';

  it('rejects invalid JSON rather than overwriting it', () => {
    expect(() => parseJsonc('{ nope', 'f.json')).toThrow(JsonError);
    expect(() => new JsonEditor('{ nope', 'f.json')).toThrow(JsonError);
  });

  it('accepts comments and trailing commas', () => {
    expect(parseJsonc('{ /* c */ "a": 1, }', 'f')).toEqual({ a: 1 });
  });

  it('setPath preserves comments and the other keys', () => {
    const out = setPath(user, ['b'], true);
    expect(out).toContain('// keep me');
    expect(parseJsonc(out, 'f')).toMatchObject({ a: 1, b: true });
  });

  it('setPath preserves CRLF and tab indentation', () => {
    const crlf = '{\r\n\t"a": 1\r\n}\r\n';
    const out = setPath(crlf, ['b'], 2);
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(out).toContain('\t"b": 2');
  });

  it('adds and removes our hook entry without touching the rest', () => {
    const ours = { hooks: [{ type: 'command', command: 'node .ai-rules/guard.mjs --tool=claude' }] };
    const ed = new JsonEditor(user, 'f.json');
    ed.set(['hooks', 'PreToolUse'], withOurs(ed.get(['hooks', 'PreToolUse']), ours));
    ed.set(['hooks', 'PreToolUse'], withOurs(ed.get(['hooks', 'PreToolUse']), ours));
    expect((ed.get(['hooks', 'PreToolUse']) as unknown[]).length).toBe(1);

    const back = new JsonEditor(ed.text, 'f.json');
    back.set(['hooks', 'PreToolUse'], withoutOurs(back.get(['hooks', 'PreToolUse'])));
    back.prune(['hooks', 'PreToolUse']);
    expect(parseJsonc(back.text, 'f')).toEqual(parseJsonc(user, 'f'));
    expect(back.text).toContain('// keep me');
  });

  it('prune removes empty containers up to a non-empty one', () => {
    const ed = new JsonEditor('{ "a": { "b": { "c": [] } }, "keep": 1 }', 'f');
    ed.prune(['a', 'b', 'c']);
    expect(parseJsonc(ed.text, 'f')).toEqual({ keep: 1 });
  });

  it('a new file that ends up empty is not created', () => {
    const ed = new JsonEditor(null, 'f');
    expect(ed.result()).toBeNull();
    ed.set(['a'], 1);
    expect(ed.result()).not.toBeNull();
  });

  it('list helpers', () => {
    expect(isOurs({ command: 'node .ai-rules/guard.mjs' })).toBe(true);
    expect(isOurs({ command: 'other' })).toBe(false);
    expect(addUnique(['a'], ['a', 'b'])).toEqual(['a', 'b']);
    expect(removeKnown(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
    expect(newJson({ a: 1 }, '\r\n')).toBe('{\r\n  "a": 1\r\n}\r\n');
  });
});

describe('eol helpers', () => {
  it('detects and converts', () => {
    expect(detectEol('a\r\nb')).toBe('\r\n');
    expect(detectEol('a\nb')).toBe('\n');
    expect(detectEol(null)).toBe('\n');
    expect(toEol('a\nb\r\nc', '\r\n')).toBe('a\r\nb\r\nc');
    expect(toEol('a\r\nb', '\n')).toBe('a\nb');
  });
});
