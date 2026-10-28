import { exists } from '../core/fsutil.js';
import { rulesBody } from '../core/rules-text.js';
import { cursorCliDeny, cursorCliDenyAll } from './native.js';
import { JsonEditor, abs, addUnique, guardCommand, isOurs, mdHasBlock, mdInstall, mdRemove, readText, removeKnown, withOurs, withoutOurs } from './shared.js';
import type { Adapter, AdapterCtx, AdapterResult, Change, CheckItem } from './types.js';

const HOOKS = '.cursor/hooks.json';
const CLI = '.cursor/cli.json';
const RULE = '.cursor/rules/ai-guardrules.mdc';
const EVENTS = ['beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile', 'preToolUse'] as const;
const HEADER = '---\ndescription: ai-guardrules guardrails, enforced by hooks\nalwaysApply: true\n---\n\n';

function entry(): unknown {
  return { command: guardCommand('cursor'), timeout: 30, failClosed: true };
}

function edit(root: string, rel: string, note: string, fn: (ed: JsonEditor) => void): Change | null {
  const before = readText(abs(root, rel));
  const ed = new JsonEditor(before, rel);
  fn(ed);
  const after = ed.result();
  return after === before ? null : { file: rel, before, after, note };
}

export const cursor: Adapter = {
  id: 'cursor',
  label: 'Cursor',
  enforcement: 'enforced',
  summary: 'hooks.json (shell, MCP, read, tool use; failClosed) + CLI deny rules + always-on rule',
  detect: (root) => exists(abs(root, '.cursor')),

  install(ctx: AdapterCtx): AdapterResult {
    const changes: Change[] = [];
    const hooks = edit(ctx.root, HOOKS, 'Cursor hooks', (ed) => {
      if (ed.get(['version']) === undefined) ed.set(['version'], 1);
      for (const ev of EVENTS) ed.set(['hooks', ev], withOurs(ed.get(['hooks', ev]), entry()));
    });
    if (hooks) changes.push(hooks);
    const cli = edit(ctx.root, CLI, 'Cursor CLI native deny rules', (ed) => {
      const current = ed.get(['permissions', 'deny']);
      const deny = addUnique(removeKnown(current, cursorCliDenyAll()), cursorCliDeny(ctx.preset));
      if (JSON.stringify(deny) !== JSON.stringify(current)) ed.set(['permissions', 'deny'], deny);
      if (ed.get(['permissions', 'allow']) === undefined) ed.set(['permissions', 'allow'], []);
    });
    if (cli) changes.push(cli);
    const rule = mdInstall(ctx.root, RULE, rulesBody(ctx.preset, ctx.customRules, 'pointer'), 'Cursor always-on rule', HEADER);
    if (rule) changes.push(rule);
    return { changes, warnings: [] };
  },

  uninstall(ctx: AdapterCtx): AdapterResult {
    const changes: Change[] = [];
    const hooks = edit(ctx.root, HOOKS, 'Cursor hooks', (ed) => {
      if (ed.original === null) return;
      for (const ev of EVENTS) {
        const cur = ed.get(['hooks', ev]);
        if (Array.isArray(cur) && cur.some(isOurs)) {
          ed.set(['hooks', ev], withoutOurs(cur));
          ed.prune(['hooks', ev]);
        }
      }
    });
    if (hooks) {
      const e = new JsonEditor(hooks.after, HOOKS);
      const d = e.doc() as { hooks?: unknown; version?: unknown };
      changes.push(d.hooks === undefined && Object.keys(d).every((k) => k === 'version') ? { ...hooks, after: null } : hooks);
    }
    const cli = edit(ctx.root, CLI, 'Cursor CLI native deny rules', (ed) => {
      if (ed.original === null) return;
      const current = ed.get(['permissions', 'deny']);
      const deny = removeKnown(current, cursorCliDenyAll());
      if (Array.isArray(current) && deny.length !== current.length) {
        ed.set(['permissions', 'deny'], deny);
        ed.prune(['permissions', 'deny']);
      }
    });
    if (cli) {
      const d = new JsonEditor(cli.after, CLI).doc() as { permissions?: { allow?: unknown[] } };
      const onlyEmptyAllow = d.permissions === undefined || (Object.keys(d.permissions).length === 1 && Array.isArray(d.permissions.allow) && d.permissions.allow.length === 0);
      changes.push(Object.keys(d).length <= 1 && onlyEmptyAllow ? { ...cli, after: null } : cli);
    }
    const rule = mdRemove(ctx.root, RULE, 'Cursor rule', HEADER);
    if (rule) changes.push(rule);
    return { changes, warnings: [] };
  },

  check(ctx: AdapterCtx): CheckItem[] {
    const items: CheckItem[] = [];
    const text = readText(abs(ctx.root, HOOKS));
    if (text === null) return [{ ok: false, label: 'Cursor hooks.json present', detail: `${HOOKS} is missing.`, critical: true }];
    try {
      const ed = new JsonEditor(text, HOOKS);
      for (const ev of EVENTS) {
        const arr = ed.get(['hooks', ev]);
        const ours = Array.isArray(arr) ? arr.find(isOurs) : undefined;
        const ok = ours !== undefined && (ours as { failClosed?: boolean }).failClosed === true;
        items.push({ ok, label: `Cursor ${ev} hook (failClosed)`, detail: ok ? undefined : ours ? 'failClosed is not true.' : 'Missing.', critical: true });
      }
    } catch (e) {
      items.push({ ok: false, label: 'Cursor hooks.json readable', detail: (e as Error).message, critical: true });
    }
    items.push({ ok: mdHasBlock(ctx.root, RULE), label: 'Cursor rule present', critical: false });
    return items;
  },
};
