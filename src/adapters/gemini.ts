import { exists } from '../core/fsutil.js';
import { rulesBody } from '../core/rules-text.js';
import { JsonEditor, abs, guardCommand, isOurs, mdHasBlock, mdInstall, mdRemove, readText, withOurs, withoutOurs } from './shared.js';
import type { Adapter, AdapterCtx, AdapterResult, Change, CheckItem } from './types.js';

const SETTINGS = '.gemini/settings.json';
const PATH = ['hooks', 'BeforeTool'];

function entry(): unknown {
  return { matcher: '.*', hooks: [{ type: 'command', command: guardCommand('gemini'), name: 'ai-rules', timeout: 30000 }] };
}

function edit(root: string, fn: (ed: JsonEditor) => void): Change | null {
  const before = readText(abs(root, SETTINGS));
  const ed = new JsonEditor(before, SETTINGS);
  fn(ed);
  const after = ed.result();
  return after === before ? null : { file: SETTINGS, before, after, note: 'Gemini CLI BeforeTool hook' };
}

export const gemini: Adapter = {
  id: 'gemini',
  label: 'Gemini CLI',
  enforcement: 'enforced',
  summary: 'BeforeTool hook (ask becomes deny) + GEMINI.md',
  detect: (root) => exists(abs(root, '.gemini')) || exists(abs(root, 'GEMINI.md')),

  install(ctx: AdapterCtx): AdapterResult {
    const changes: Change[] = [];
    const s = edit(ctx.root, (ed) => ed.set(PATH, withOurs(ed.get(PATH), entry())));
    if (s) changes.push(s);
    const md = mdInstall(ctx.root, 'GEMINI.md', '@./AGENTS.md\n\n' + rulesBody(ctx.preset, ctx.customRules, 'pointer'), 'Gemini CLI rules (imports AGENTS.md)');
    if (md) changes.push(md);
    return { changes, warnings: ['Gemini CLI cannot ask for approval from a hook, so anything that needs approval is blocked. Approve with "ai-rules allow".'] };
  },

  uninstall(ctx: AdapterCtx): AdapterResult {
    const changes: Change[] = [];
    const s = edit(ctx.root, (ed) => {
      if (ed.original === null) return;
      const cur = ed.get(PATH);
      if (Array.isArray(cur) && cur.some(isOurs)) {
        ed.set(PATH, withoutOurs(cur));
        ed.prune(PATH);
      }
    });
    if (s) changes.push(new JsonEditor(s.after, SETTINGS).isEmptyObject() ? { ...s, after: null } : s);
    const md = mdRemove(ctx.root, 'GEMINI.md', 'Gemini CLI rules');
    if (md) changes.push(md);
    return { changes, warnings: [] };
  },

  check(ctx: AdapterCtx): CheckItem[] {
    const text = readText(abs(ctx.root, SETTINGS));
    const items: CheckItem[] = [];
    let ok = false;
    try {
      const arr = text ? new JsonEditor(text, SETTINGS).get(PATH) : undefined;
      ok = Array.isArray(arr) && arr.some(isOurs);
    } catch (e) {
      items.push({ ok: false, label: 'Gemini settings readable', detail: (e as Error).message, critical: true });
    }
    items.push({ ok, label: 'Gemini BeforeTool hook installed', detail: ok ? undefined : `Missing from ${SETTINGS}.`, critical: true });
    items.push({ ok: mdHasBlock(ctx.root, 'GEMINI.md'), label: 'GEMINI.md rules block present', critical: false });
    return items;
  },
};
