import { exists } from '../core/fsutil.js';
import { rulesBody } from '../core/rules-text.js';
import { JsonEditor, abs, guardCommand, isOurs, mdHasBlock, mdInstall, mdRemove, readText, withOurs, withoutOurs } from './shared.js';
import type { Adapter, AdapterCtx, AdapterResult, Change, CheckItem } from './types.js';

const DEVIN = '.devin/hooks.json';
const LEGACY = '.windsurf/hooks.json';
const RULE = '.windsurf/rules/ai-rules.md';
const EVENTS = ['pre_run_command', 'pre_read_code', 'pre_write_code', 'pre_mcp_tool_use'] as const;
const HEADER = '---\ntrigger: always_on\n---\n\n';

function entry(): unknown {
  const cmd = guardCommand('windsurf');
  return { command: cmd, powershell: cmd, show_output: false };
}

/** Use the legacy file only when the project already has one and no .devin file. */
function targetFile(root: string): string {
  return exists(abs(root, LEGACY)) && !exists(abs(root, DEVIN)) ? LEGACY : DEVIN;
}

function edit(root: string, rel: string, fn: (ed: JsonEditor) => void): Change | null {
  const before = readText(abs(root, rel));
  const ed = new JsonEditor(before, rel);
  fn(ed);
  const after = ed.result();
  return after === before ? null : { file: rel, before, after, note: 'Windsurf hooks' };
}

export const windsurf: Adapter = {
  id: 'windsurf',
  label: 'Windsurf',
  enforcement: 'enforced',
  summary: 'pre-run/read/write/MCP hooks (ask becomes deny) + always-on rule',
  detect: (root) => exists(abs(root, '.windsurf')) || exists(abs(root, '.devin')) || exists(abs(root, '.windsurfrules')),

  install(ctx: AdapterCtx): AdapterResult {
    const changes: Change[] = [];
    const file = targetFile(ctx.root);
    const h = edit(ctx.root, file, (ed) => {
      for (const ev of EVENTS) ed.set(['hooks', ev], withOurs(ed.get(['hooks', ev]), entry()));
    });
    if (h) changes.push(h);
    const rule = mdInstall(ctx.root, RULE, rulesBody(ctx.preset, ctx.customRules, 'pointer'), 'Windsurf always-on rule', HEADER);
    if (rule) changes.push(rule);
    return { changes, warnings: ['Windsurf hooks cannot ask for approval, so anything that needs approval is blocked. Approve with "ai-rules allow".'] };
  },

  uninstall(ctx: AdapterCtx): AdapterResult {
    const changes: Change[] = [];
    for (const file of [DEVIN, LEGACY]) {
      const h = edit(ctx.root, file, (ed) => {
        if (ed.original === null) return;
        for (const ev of EVENTS) {
          const cur = ed.get(['hooks', ev]);
          if (Array.isArray(cur) && cur.some(isOurs)) {
            ed.set(['hooks', ev], withoutOurs(cur));
            ed.prune(['hooks', ev]);
          }
        }
      });
      if (h) changes.push(new JsonEditor(h.after, file).isEmptyObject() ? { ...h, after: null } : h);
    }
    const rule = mdRemove(ctx.root, RULE, 'Windsurf rule', HEADER);
    if (rule) changes.push(rule);
    return { changes, warnings: [] };
  },

  check(ctx: AdapterCtx): CheckItem[] {
    const items: CheckItem[] = [];
    const file = targetFile(ctx.root);
    const text = readText(abs(ctx.root, file));
    try {
      const ed = text ? new JsonEditor(text, file) : null;
      for (const ev of EVENTS) {
        const arr = ed?.get(['hooks', ev]);
        const ok = Array.isArray(arr) && arr.some(isOurs);
        items.push({ ok, label: `Windsurf ${ev} hook`, detail: ok ? undefined : `Missing from ${file}.`, critical: true });
      }
    } catch (e) {
      items.push({ ok: false, label: 'Windsurf hooks readable', detail: (e as Error).message, critical: true });
    }
    items.push({ ok: mdHasBlock(ctx.root, RULE), label: 'Windsurf rule present', critical: false });
    return items;
  },
};
