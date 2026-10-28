import { rulesBody } from '../core/rules-text.js';
import { claudeDeny, claudeDenyAll } from './native.js';
import { JsonEditor, abs, addUnique, guardArgs, isOurs, mdHasBlock, mdInstall, mdRemove, readText, removeKnown, withOurs, withoutOurs } from './shared.js';
import type { Adapter, AdapterCtx, AdapterResult, Change, CheckItem } from './types.js';
import { exists } from '../core/fsutil.js';

const SETTINGS = '.claude/settings.json';
const LOCAL = '.claude/settings.local.json';

function sharedEntry(): unknown {
  return { matcher: '.*', hooks: [{ type: 'command', command: 'node', args: guardArgs('claude'), timeout: 30, onFailure: 'block' }] };
}

/** Machine-local wrapper: also blocks when `node` is missing or the guard exits with an unexpected code. */
function wrapperEntry(windows: boolean): unknown {
  const line = 'node .ai-guardrules/guard.mjs --tool=claude';
  const command = windows
    ? `powershell -NoProfile -Command "& ${line}; $c = $LASTEXITCODE; if ($null -eq $c -or ($c -ne 0 -and $c -ne 2)) { exit 2 }; exit $c"`
    : `${line}; c=$?; if [ "$c" -ne 0 ] && [ "$c" -ne 2 ]; then exit 2; fi; exit "$c"`;
  return { matcher: '.*', hooks: [{ type: 'command', command, timeout: 30, onFailure: 'block' }] };
}

function hookPath(): (string | number)[] {
  return ['hooks', 'PreToolUse'];
}

function dropOurs(ed: JsonEditor): void {
  const cur = ed.get(hookPath());
  if (Array.isArray(cur) && cur.some(isOurs)) {
    ed.set(hookPath(), withoutOurs(cur));
    ed.prune(hookPath());
  }
}

function editSettings(root: string, rel: string, fn: (ed: JsonEditor) => void): Change | null {
  const before = readText(abs(root, rel));
  const ed = new JsonEditor(before, rel);
  fn(ed);
  const after = ed.result();
  if (after === before) return null;
  return { file: rel, before, after, note: rel === SETTINGS ? 'Claude Code hook and native permissions' : 'Claude Code local hook wrapper' };
}

export const claude: Adapter = {
  id: 'claude',
  label: 'Claude Code',
  enforcement: 'enforced',
  summary: 'PreToolUse hook (fail-closed) + native deny rules + CLAUDE.md',
  detect: (root) => exists(abs(root, '.claude')) || exists(abs(root, 'CLAUDE.md')),

  install(ctx: AdapterCtx): AdapterResult {
    const warnings: string[] = [];
    const changes: Change[] = [];
    const windows = process.platform === 'win32';

    const s = editSettings(ctx.root, SETTINGS, (ed) => {
      if (ctx.localWrapper) dropOurs(ed);
      else ed.set(hookPath(), withOurs(ed.get(hookPath()), sharedEntry()));
      const current = ed.get(['permissions', 'deny']);
      const deny = addUnique(removeKnown(current, claudeDenyAll()), claudeDeny(ctx.preset));
      if (JSON.stringify(deny) !== JSON.stringify(current)) ed.set(['permissions', 'deny'], deny);
      if (ed.get(['disableAllHooks']) === true) {
        if (ctx.force) ed.set(['disableAllHooks'], undefined);
        else warnings.push(`${SETTINGS} sets "disableAllHooks": true, which turns every hook off. Re-run with --force to remove it.`);
      }
    });
    if (s) changes.push(s);

    const l = editSettings(ctx.root, LOCAL, (ed) => {
      if (ctx.localWrapper) ed.set(hookPath(), withOurs(ed.get(hookPath()), wrapperEntry(windows)));
      else dropOurs(ed);
      if (ed.get(['disableAllHooks']) === true) {
        if (ctx.force) ed.set(['disableAllHooks'], undefined);
        else warnings.push(`${LOCAL} sets "disableAllHooks": true, which turns every hook off. Re-run with --force to remove it.`);
      }
    });
    if (l) changes.push(l);

    const md = mdInstall(ctx.root, 'CLAUDE.md', '@AGENTS.md\n\n' + rulesBody(ctx.preset, ctx.customRules, 'pointer'), 'Claude Code rules (imports AGENTS.md)');
    if (md) changes.push(md);
    if (ctx.localWrapper) warnings.push('--local-wrapper: the Claude hook is only in .claude/settings.local.json (gitignored). Teammates must run init themselves.');
    return { changes, warnings };
  },

  uninstall(ctx: AdapterCtx): AdapterResult {
    const changes: Change[] = [];
    for (const rel of [SETTINGS, LOCAL]) {
      const c = editSettings(ctx.root, rel, (ed) => {
        if (ed.original === null) return;
        dropOurs(ed);
        if (rel === SETTINGS) {
          const current = ed.get(['permissions', 'deny']);
          const deny = removeKnown(current, claudeDenyAll());
          if (Array.isArray(current) && deny.length !== current.length) {
            ed.set(['permissions', 'deny'], deny);
            ed.prune(['permissions', 'deny']);
          }
        }
      });
      if (c) {
        // Remove a file that only held our settings.
        const ed = new JsonEditor(c.after, rel);
        changes.push(ed.isEmptyObject() ? { ...c, after: null } : c);
      }
    }
    const md = mdRemove(ctx.root, 'CLAUDE.md', 'Claude Code rules');
    if (md) changes.push(md);
    return { changes, warnings: [] };
  },

  check(ctx: AdapterCtx): CheckItem[] {
    const items: CheckItem[] = [];
    for (const rel of [SETTINGS, LOCAL]) {
      const text = readText(abs(ctx.root, rel));
      if (text === null) continue;
      try {
        const ed = new JsonEditor(text, rel);
        if (ed.get(['disableAllHooks']) === true) items.push({ ok: false, label: `${rel}: disableAllHooks is true`, detail: 'Every hook is switched off.', critical: true });
      } catch (e) {
        items.push({ ok: false, label: `${rel} is unreadable`, detail: (e as Error).message, critical: true });
      }
    }
    const text = readText(abs(ctx.root, SETTINGS)) ?? '';
    const local = readText(abs(ctx.root, LOCAL)) ?? '';
    let hooked = false;
    let failClosed = false;
    try {
      for (const t of [text, local]) {
        if (!t) continue;
        const arr = new JsonEditor(t, 'settings').get(hookPath());
        if (Array.isArray(arr)) {
          for (const e of arr) {
            if (isOurs(e)) {
              hooked = true;
              if (JSON.stringify(e).includes('"onFailure":"block"')) failClosed = true;
            }
          }
        }
      }
    } catch {
      /* reported above */
    }
    items.push({ ok: hooked, label: 'Claude PreToolUse hook installed', detail: hooked ? undefined : `Missing from ${SETTINGS}.`, critical: true });
    if (hooked) items.push({ ok: failClosed, label: 'Claude hook is fail-closed (onFailure: block)', critical: true });
    try {
      const deny = new JsonEditor(text || null, SETTINGS).get(['permissions', 'deny']);
      const have = Array.isArray(deny) ? (deny as unknown[]) : [];
      const missing = claudeDeny(ctx.preset).filter((r) => !have.includes(r));
      items.push({ ok: missing.length === 0, label: 'Claude native deny rules present', detail: missing.length ? `${missing.length} missing, e.g. ${missing[0]}` : undefined, critical: false });
    } catch {
      /* reported above */
    }
    items.push({ ok: mdHasBlock(ctx.root, 'CLAUDE.md'), label: 'CLAUDE.md rules block present', critical: false });
    return items;
  },
};