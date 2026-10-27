import { claude } from './claude.js';
import { codex } from './codex.js';
import { cursor } from './cursor.js';
import { gemini } from './gemini.js';
import { agents, cline, copilot } from './rules-only.js';
import { TOOL_IDS, type Adapter, type ToolId } from './types.js';
import { windsurf } from './windsurf.js';

export const ADAPTERS: Record<ToolId, Adapter> = { claude, cursor, gemini, windsurf, codex, copilot, cline, agents };

export function getAdapter(id: ToolId): Adapter {
  return ADAPTERS[id];
}

export function isToolId(x: string): x is ToolId {
  return (TOOL_IDS as readonly string[]).includes(x);
}

export function parseTools(list: string): ToolId[] {
  const out: ToolId[] = [];
  for (const raw of list.split(',')) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (!isToolId(t)) throw new Error(`Unknown tool "${t}". Choose from: ${TOOL_IDS.join(', ')}`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

export { TOOL_IDS };
export type { Adapter, ToolId };
