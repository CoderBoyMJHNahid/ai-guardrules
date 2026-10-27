import { exists } from '../core/fsutil.js';
import { hasTomlBlock, removeTomlBlock, upsertTomlBlock } from '../core/toml.js';
import { JsonEditor, abs, guardCommand, isOurs, readText, withOurs, withoutOurs } from './shared.js';
import type { Adapter, AdapterCtx, AdapterResult, Change, CheckItem } from './types.js';

const HOOKS = '.codex/hooks.json';
const CONFIG = '.codex/config.toml';
const PATH = ['hooks', 'PreToolUse'];

function entry(): unknown {
  return { matcher: '.*', hooks: [{ type: 'command', command: guardCommand('codex'), timeout: 30 }] };
}

function editHooks(root: string, fn: (ed: JsonEditor) => void): Change | null {
  const before = readText(abs(root, HOOKS));
  const ed = new JsonEditor(before, HOOKS);
  fn(ed);
  const after = ed.result();
  return after === before ? null : { file: HOOKS, before, after, note: 'Codex PreToolUse hook' };
}

export const codex: Adapter = {
  id: 'codex',
  label: 'Codex',
  enforcement: 'enforced',
  summary: 'PreToolUse hook (ask becomes deny) + workspace-write sandbox in config.toml',
  detect: (root) => exists(abs(root, '.codex')),

  install(ctx: AdapterCtx): AdapterResult {
    const changes: Change[] = [];
    const warnings: string[] = ['Codex asks you to review new hooks once. Run /hooks in Codex and trust the ai-rules hook.', 'Codex hooks cannot ask for approval, so anything that needs approval is blocked. Approve with "ai-rules allow".'];
    const h = editHooks(ctx.root, (ed) => ed.set(PATH, withOurs(ed.get(PATH), entry())));
    if (h) changes.push(h);
    const before = readText(abs(ctx.root, CONFIG));
    const { text, skipped } = upsertTomlBlock(before, [
      ['approval_policy', '"on-request"'],
      ['sandbox_mode', '"workspace-write"'],
    ]);
    if (skipped.length) warnings.push(`${CONFIG} already sets ${skipped.join(', ')}. Left unchanged; check it matches your intent.`);
    if (text !== before) changes.push({ file: CONFIG, before, after: text, note: 'Codex approval policy and sandbox' });
    return { changes, warnings };
  },

  uninstall(ctx: AdapterCtx): AdapterResult {
    const changes: Change[] = [];
    const h = editHooks(ctx.root, (ed) => {
      if (ed.original === null) return;
      const cur = ed.get(PATH);
      if (Array.isArray(cur) && cur.some(isOurs)) {
        ed.set(PATH, withoutOurs(cur));
        ed.prune(PATH);
      }
    });
    if (h) changes.push(new JsonEditor(h.after, HOOKS).isEmptyObject() ? { ...h, after: null } : h);
    const before = readText(abs(ctx.root, CONFIG));
    if (before !== null && hasTomlBlock(before)) changes.push({ file: CONFIG, before, after: removeTomlBlock(before), note: 'Codex approval policy and sandbox' });
    return { changes, warnings: [] };
  },

  check(ctx: AdapterCtx): CheckItem[] {
    const items: CheckItem[] = [];
    const text = readText(abs(ctx.root, HOOKS));
    let ok = false;
    try {
      const arr = text ? new JsonEditor(text, HOOKS).get(PATH) : undefined;
      ok = Array.isArray(arr) && arr.some(isOurs);
    } catch (e) {
      items.push({ ok: false, label: 'Codex hooks readable', detail: (e as Error).message, critical: true });
    }
    items.push({ ok, label: 'Codex PreToolUse hook installed', detail: ok ? undefined : `Missing from ${HOOKS}.`, critical: true });
    items.push({ ok: hasTomlBlock(readText(abs(ctx.root, CONFIG))), label: 'Codex sandbox settings present', critical: false });
    return items;
  },
};
