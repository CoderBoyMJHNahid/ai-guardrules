export type Decision = 'allow' | 'ask' | 'deny';
export type Mode = 'allow' | 'ask' | 'deny' | 'off';
export type Dialect = 'bash' | 'powershell' | 'cmd';

export type CallKind =
  | 'shell'
  | 'read'
  | 'write' // creates or overwrites a file
  | 'edit' // modifies an existing file
  | 'delete'
  | 'search'
  | 'mcp'
  | 'other';

/** Tool-independent description of one agent action. */
export interface Call {
  kind: CallKind;
  tool: string; // agent that sent it: claude, cursor, ...
  toolName: string; // agent's own tool name
  cwd: string;
  command?: string;
  dialect?: Dialect;
  /** Paths touched by file tools (absolute or as sent). */
  paths?: string[];
  /** Extra search inputs (glob / pattern) for search tools. */
  patterns?: string[];
  /** MCP details. */
  mcp?: { server: string; tool: string; input: string };
  /** Raw tool input, used by custom hooks. */
  input?: unknown;
  /** Agent session identifier, when known. */
  session?: string;
  /** Agent hook event name (agent-specific; used to decide whether `ask` is supported). */
  event?: string;
}

export interface Verdict {
  decision: Decision;
  guard: string;
  message: string;
  /** True when the user explicitly allowed it (allowlist, grant, custom allow). */
  explicit?: boolean;
  /** Whether a user grant may relax this verdict. */
  grantable?: boolean;
  /** What a grant has to match: the shell command text, or a path. */
  grantKind?: 'command' | 'path' | 'create';
  /** Absolute paths involved, for path and create grants. */
  grantPaths?: string[];
}

export interface Grant {
  id: string;
  kind: 'command' | 'path' | 'create';
  pattern: string;
  createdAt: number;
  expiresAt: number | null;
  once: boolean;
}

export interface CustomGuard {
  id: string;
  on: 'shell' | 'read' | 'write' | 'edit' | 'mcp' | 'any';
  /** Command name (shell) or tool name glob (mcp). */
  command?: string;
  /** Glob matched against the command arguments (shell) or the whole command when `command` is absent. */
  match?: string;
  /** Path glob (file tools, and path arguments of shell commands). */
  path?: string;
  decision: Mode;
  message: string;
}

export interface CustomHook {
  id: string;
  event: 'before-shell' | 'before-read' | 'before-write' | 'before-mcp' | 'any';
  run: string;
  timeoutMs?: number;
}

export const PASS: Verdict = { decision: 'allow', guard: 'none', message: '' };

export const RANK: Record<Decision, number> = { allow: 0, ask: 1, deny: 2 };

export function worse(a: Verdict, b: Verdict): Verdict {
  return RANK[b.decision] > RANK[a.decision] ? b : a;
}

export interface Policy {
  version: number;
  preset: 'strict' | 'standard' | 'custom';
  guards: Record<string, Mode>;
  secrets: { paths: string[]; allow: string[] };
  git: { allow: string[] };
  database: { commands: string[]; mcpPatterns: string[] };
  protected: string[];
  /** Tool names that never need approval (agent bookkeeping tools). */
  safeTools: string[];
}

export const HARD_GUARDS = ['databaseDelete', 'secrets', 'selfProtection', 'destructive'] as const;
