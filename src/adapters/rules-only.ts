import { exists, isFile } from '../core/fsutil.js';
import { rulesBody } from '../core/rules-text.js';
import { abs, mdHasBlock, mdInstall, mdRemove } from './shared.js';
import type { Adapter, AdapterCtx, AdapterResult } from './types.js';

function single(id: Adapter['id'], label: string, summary: string, detectPaths: string[], file: (root: string) => string, mode: 'full' | 'pointer', header = ''): Adapter {
  return {
    id,
    label,
    enforcement: 'advisory',
    summary,
    detect: (root) => detectPaths.some((p) => exists(abs(root, p))),
    install(ctx: AdapterCtx): AdapterResult {
      const c = mdInstall(ctx.root, file(ctx.root), rulesBody(ctx.preset, ctx.customRules, mode), `${label} rules`, header);
      return { changes: c ? [c] : [], warnings: [] };
    },
    uninstall(ctx: AdapterCtx): AdapterResult {
      const c = mdRemove(ctx.root, file(ctx.root), `${label} rules`, header);
      return { changes: c ? [c] : [], warnings: [] };
    },
    check(ctx: AdapterCtx) {
      return [{ ok: mdHasBlock(ctx.root, file(ctx.root)), label: `${label} rules present (advisory only)`, critical: false }];
    },
  };
}

export const agents = single('agents', 'AGENTS.md', 'canonical rules for Codex, Cursor, Copilot, Windsurf and others', ['AGENTS.md'], () => 'AGENTS.md', 'full');

export const copilot = single('copilot', 'GitHub Copilot', 'instructions file (advisory, no blocking hooks)', ['.github/copilot-instructions.md', '.github/instructions'], () => '.github/copilot-instructions.md', 'pointer');

/** `.clinerules` can be a file or a folder. */
export const cline = single('cline', 'Cline', 'rules file (advisory, no blocking hooks)', ['.clinerules', '.clineignore'], (root) => (isFile(abs(root, '.clinerules')) ? '.clinerules' : '.clinerules/ai-rules.md'), 'pointer');
