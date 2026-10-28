import type { PresetName } from '../core/rules-text.js';

export const TOOL_IDS = ['claude', 'cursor', 'gemini', 'windsurf', 'codex', 'copilot', 'cline', 'agents'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export interface Change {
  /** Path relative to the project root, with forward slashes. */
  file: string;
  before: string | null;
  after: string | null;
  note: string;
}

export interface AdapterCtx {
  root: string;
  preset: PresetName;
  /** Contents of .ai-guardrules/custom/rules.md. */
  customRules: string;
  /** Write the stricter machine-local hook wrapper instead of the shared one (Claude only). */
  localWrapper: boolean;
  /** Force-fix settings such as `disableAllHooks`. */
  force: boolean;
}

export interface AdapterResult {
  changes: Change[];
  warnings: string[];
}

export interface CheckItem {
  ok: boolean;
  label: string;
  detail?: string;
  /** When false and not ok, the problem is a warning rather than a failure. */
  critical?: boolean;
}

export interface Adapter {
  id: ToolId;
  label: string;
  enforcement: 'enforced' | 'advisory';
  /** One line shown in the init summary. */
  summary: string;
  detect(root: string): boolean;
  install(ctx: AdapterCtx): AdapterResult;
  uninstall(ctx: AdapterCtx): AdapterResult;
  check(ctx: AdapterCtx): CheckItem[];
}
