import type { Call, Decision, Dialect, Verdict } from './types.js';

export const AGENTS = ['claude', 'cursor', 'gemini', 'windsurf', 'codex'] as const;
export type AgentId = (typeof AGENTS)[number];

export function isAgent(x: string | undefined): x is AgentId {
  return !!x && (AGENTS as readonly string[]).includes(x);
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj {
  if (typeof v === 'string') {
    try {
      const p: unknown = JSON.parse(v);
      if (typeof p === 'object' && p !== null && !Array.isArray(p)) return p as Obj;
    } catch {
      /* not JSON */
    }
    return {};
  }
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : {};
}

function str(...vs: unknown[]): string | undefined {
  for (const v of vs) if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

function strs(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return [];
}

function defaultDialect(): Dialect {
  return process.platform === 'win32' ? 'powershell' : 'bash';
}

function toJson(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return '';
  }
}

export interface NormalizeCtx {
  root: string;
}

/** Thrown when a payload is understood but cannot be mapped safely. */
export class PayloadError extends Error {}

// ---------------------------------------------------------------------------
// Claude Code and Codex share a payload shape (Codex adds apply_patch)
// ---------------------------------------------------------------------------

function parseMcpName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return { server: m[1] as string, tool: m[2] as string };
  const g = /^mcp_(.+?)_(.+)$/.exec(name);
  if (g) return { server: g[1] as string, tool: g[2] as string };
  const c = /^MCP:(.+)$/.exec(name);
  if (c) return { server: '', tool: c[1] as string };
  return null;
}

function parsePatchPaths(patch: string): Array<{ kind: Call['kind']; path: string }> {
  const out: Array<{ kind: Call['kind']; path: string }> = [];
  for (const line of patch.split(/\r?\n/)) {
    let m = /^\*\*\* Add File:\s*(.+)$/.exec(line);
    if (m) out.push({ kind: 'write', path: (m[1] as string).trim() });
    m = /^\*\*\* Update File:\s*(.+)$/.exec(line);
    if (m) out.push({ kind: 'edit', path: (m[1] as string).trim() });
    m = /^\*\*\* Delete File:\s*(.+)$/.exec(line);
    if (m) out.push({ kind: 'delete', path: (m[1] as string).trim() });
    m = /^\*\*\* Move to:\s*(.+)$/.exec(line);
    if (m) out.push({ kind: 'write', path: (m[1] as string).trim() });
  }
  return out;
}

function claudeLike(agent: 'claude' | 'codex', p: Obj, ctx: NormalizeCtx): Call[] {
  const name = str(p.tool_name) ?? '';
  if (!name) throw new PayloadError('hook payload has no tool_name');
  const input = obj(p.tool_input);
  const cwd = str(p.cwd) ?? ctx.root;
  const base = { tool: agent, toolName: name, cwd, input: p.tool_input, session: str(p.session_id), event: str(p.hook_event_name) };
  const lower = name.toLowerCase();

  const mcp = parseMcpName(name);
  if (mcp && name.startsWith('mcp__')) {
    return [{ ...base, kind: 'mcp', mcp: { ...mcp, input: toJson(p.tool_input) } }];
  }
  if (name === 'apply_patch' || lower === 'applypatch') {
    const patch = str(input.command, input.patch, input.input) ?? '';
    const files = parsePatchPaths(patch);
    if (files.length === 0) throw new PayloadError('apply_patch payload has no recognisable file headers');
    return files.map((f) => ({ ...base, kind: f.kind, paths: [f.path] }));
  }
  switch (name) {
    case 'Bash':
    case 'bash':
    case 'Shell':
      return [{ ...base, kind: 'shell', command: str(input.command) ?? '', dialect: 'bash' }];
    case 'PowerShell':
      return [{ ...base, kind: 'shell', command: str(input.command) ?? '', dialect: 'powershell' }];
    case 'Read':
      return [{ ...base, kind: 'read', paths: [str(input.file_path, input.path) ?? ''] }];
    case 'Write':
      return [{ ...base, kind: 'write', paths: [str(input.file_path, input.path) ?? ''] }];
    case 'Edit':
    case 'MultiEdit':
      return [{ ...base, kind: 'edit', paths: [str(input.file_path, input.path) ?? ''] }];
    case 'NotebookEdit':
      return [{ ...base, kind: 'edit', paths: [str(input.notebook_path, input.file_path) ?? ''] }];
    case 'NotebookRead':
      return [{ ...base, kind: 'read', paths: [str(input.notebook_path, input.file_path) ?? ''] }];
    case 'Glob':
      return [{ ...base, kind: 'search', paths: [str(input.path) ?? cwd], patterns: strs(input.pattern) }];
    case 'Grep':
      return [{ ...base, kind: 'search', paths: [str(input.path) ?? cwd], patterns: strs(input.glob) }];
    case 'LS':
      return [{ ...base, kind: 'search', paths: [str(input.path) ?? cwd], patterns: [] }];
    default:
      return [{ ...base, kind: 'other' }];
  }
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

function cursorCwd(p: Obj, ctx: NormalizeCtx): string {
  const roots = Array.isArray(p.workspace_roots) ? strs(p.workspace_roots) : [];
  return str(p.cwd) ?? roots[0] ?? ctx.root;
}

function cursor(p: Obj, ctx: NormalizeCtx): Call[] {
  const event = str(p.hook_event_name) ?? '';
  const cwd = cursorCwd(p, ctx);
  const base = { tool: 'cursor', cwd, event, session: str(p.conversation_id) };
  switch (event) {
    case 'beforeShellExecution':
      return [{ ...base, toolName: 'Shell', kind: 'shell', command: str(p.command) ?? '', dialect: defaultDialect() }];
    case 'beforeMCPExecution': {
      const tool = str(p.tool_name) ?? '';
      const server = str(p.mcp_server_name, p.server, p.server_name) ?? '';
      return [{ ...base, toolName: tool, kind: 'mcp', mcp: { server, tool, input: toJson(p.tool_input) }, input: p.tool_input }];
    }
    case 'beforeReadFile':
      return [{ ...base, toolName: 'Read', kind: 'read', paths: [str(p.file_path) ?? ''] }];
    case 'preToolUse': {
      const name = str(p.tool_name) ?? '';
      const input = obj(p.tool_input);
      const b = { ...base, toolName: name, input: p.tool_input };
      // Shell and MCP calls have dedicated hooks that can ask; skip them here to avoid double handling.
      if (name === 'Shell' || name.startsWith('MCP:') || name === 'MCP') return [];
      switch (name) {
        case 'Read':
          return [{ ...b, kind: 'read', paths: [str(input.path, input.file_path, input.target_file) ?? ''] }];
        case 'Write':
          return [{ ...b, kind: 'write', paths: [str(input.path, input.file_path, input.target_file) ?? ''] }];
        case 'StrReplace':
        case 'Edit':
        case 'EditNotebook':
          return [{ ...b, kind: 'edit', paths: [str(input.path, input.file_path, input.target_notebook) ?? ''] }];
        case 'Delete':
          return [{ ...b, kind: 'delete', paths: [str(input.path, input.file_path, input.target_file) ?? ''] }];
        case 'Glob':
          return [{ ...b, kind: 'search', paths: [str(input.target_directory, input.path) ?? cwd], patterns: strs(input.glob_pattern ?? input.pattern) }];
        case 'Grep':
          return [{ ...b, kind: 'search', paths: [str(input.path) ?? cwd], patterns: strs(input.glob) }];
        default:
          return [{ ...b, kind: 'other' }];
      }
    }
    default:
      throw new PayloadError(`unknown Cursor hook event "${event}"`);
  }
}

// ---------------------------------------------------------------------------
// Gemini CLI
// ---------------------------------------------------------------------------

function gemini(p: Obj, ctx: NormalizeCtx): Call[] {
  const name = str(p.tool_name) ?? '';
  if (!name) throw new PayloadError('hook payload has no tool_name');
  const input = obj(p.tool_input);
  const cwd = str(p.cwd) ?? ctx.root;
  const base = { tool: 'gemini', toolName: name, cwd, input: p.tool_input, session: str(p.session_id), event: str(p.hook_event_name) };
  const mcp = name.startsWith('mcp_') ? parseMcpName(name) : null;
  if (mcp) return [{ ...base, kind: 'mcp', mcp: { ...mcp, input: toJson(p.tool_input) } }];
  switch (name) {
    case 'run_shell_command':
      return [{ ...base, kind: 'shell', command: str(input.command) ?? '', dialect: defaultDialect() }];
    case 'read_file':
      return [{ ...base, kind: 'read', paths: [str(input.file_path, input.absolute_path, input.path) ?? ''] }];
    case 'read_many_files':
      return [{ ...base, kind: 'search', paths: strs(input.paths).length ? strs(input.paths) : [cwd], patterns: [...strs(input.include), ...strs(input.paths)] }];
    case 'write_file':
      return [{ ...base, kind: 'write', paths: [str(input.file_path, input.path) ?? ''] }];
    case 'replace':
      return [{ ...base, kind: 'edit', paths: [str(input.file_path, input.path) ?? ''] }];
    case 'glob':
      return [{ ...base, kind: 'search', paths: [str(input.dir_path, input.path) ?? cwd], patterns: strs(input.pattern) }];
    case 'search_file_content':
    case 'grep_search':
      return [{ ...base, kind: 'search', paths: [str(input.dir_path, input.path) ?? cwd], patterns: strs(input.include) }];
    case 'list_directory':
      return [{ ...base, kind: 'search', paths: [str(input.dir_path, input.path) ?? cwd], patterns: [] }];
    default:
      return [{ ...base, kind: 'other' }];
  }
}

// ---------------------------------------------------------------------------
// Windsurf / Devin
// ---------------------------------------------------------------------------

function windsurf(p: Obj, ctx: NormalizeCtx): Call[] {
  const action = str(p.agent_action_name) ?? '';
  const info = obj(p.tool_info);
  const cwd = str(info.cwd, p.cwd) ?? ctx.root;
  const base = { tool: 'windsurf', cwd, event: action, session: str(p.trajectory_id) };
  switch (action) {
    case 'pre_run_command':
      return [{ ...base, toolName: 'run_command', kind: 'shell', command: str(info.command_line, info.command) ?? '', dialect: defaultDialect() }];
    case 'pre_read_code':
      return [{ ...base, toolName: 'read_code', kind: 'read', paths: [str(info.file_path) ?? ''] }];
    case 'pre_write_code':
      return [{ ...base, toolName: 'write_code', kind: 'write', paths: [str(info.file_path) ?? ''] }];
    case 'pre_mcp_tool_use': {
      const server = str(info.mcp_server_name, info.server) ?? '';
      const tool = str(info.mcp_tool_name, info.tool) ?? '';
      return [{ ...base, toolName: tool, kind: 'mcp', mcp: { server, tool, input: toJson(info.mcp_tool_arguments ?? info.arguments) } }];
    }
    default:
      throw new PayloadError(`unknown Windsurf action "${action}"`);
  }
}

export function normalize(agent: AgentId, payload: unknown, ctx: NormalizeCtx): Call[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new PayloadError('hook payload is not a JSON object');
  const p = payload as Obj;
  let calls: Call[];
  switch (agent) {
    case 'claude':
      calls = claudeLike('claude', p, ctx);
      break;
    case 'codex':
      calls = claudeLike('codex', p, ctx);
      break;
    case 'cursor':
      calls = cursor(p, ctx);
      break;
    case 'gemini':
      calls = gemini(p, ctx);
      break;
    case 'windsurf':
      calls = windsurf(p, ctx);
      break;
  }
  for (const c of calls) {
    if (c.kind === 'shell' && !(c.command ?? '').trim()) throw new PayloadError('shell call without a command');
    if (c.paths && c.paths.some((x) => x === '')) {
      if (c.kind !== 'search') throw new PayloadError(`${c.toolName} call without a file path`);
    }
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface Outcome {
  decision: Decision;
  guard: string;
  message: string;
  explicit: boolean;
  grantable: boolean;
  grantKind?: Verdict['grantKind'];
}

export interface Output {
  stdout: string;
  stderr: string;
  code: number;
}

/** Whether the agent can show an approval prompt for this event. */
export function canAsk(agent: AgentId, event: string | undefined): boolean {
  switch (agent) {
    case 'claude':
      return true;
    case 'cursor':
      return event === 'beforeShellExecution' || event === 'beforeMCPExecution';
    default:
      return false;
  }
}

function clip(s: string, n = 160): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function approvalHint(o: Outcome, call: Call | undefined): string {
  if (!o.grantable) return 'This is a hard rule. It cannot be approved. Do not retry or work around it; tell the user.';
  let how = '';
  if (call?.kind === 'shell') how = ` They can approve it with: ai-rules allow "${clip(call.command ?? '', 120).replace(/"/g, '\\"')}"`;
  else if (o.grantKind === 'create' && call?.paths?.[0]) how = ` They can approve it with: ai-rules allow-create "${clip(call.paths[0], 120)}"`;
  else if (o.grantKind === 'path' && call?.paths?.[0]) how = ` They can approve it with: ai-rules allow --path "${clip(call.paths[0], 120)}"`;
  else if (call?.kind === 'mcp') how = ` They can approve it with: ai-rules allow "mcp:${call.mcp?.server ?? ''}:${call.mcp?.tool ?? call.toolName}"`;
  else if (call?.kind === 'other') how = ` They can approve it with: ai-rules allow "tool:${call.toolName}"`;
  return `Do not retry or work around this. Ask the user in chat for permission.${how}`;
}

export function explain(o: Outcome, call: Call | undefined, askUnsupported: boolean): string {
  const lead = o.decision === 'ask' && !askUnsupported ? 'needs your approval' : o.decision === 'ask' ? 'needs approval, but this agent cannot prompt for it' : 'blocked';
  return `[ai-rules] ${o.guard}: ${lead}. ${o.message} ${o.decision === 'allow' ? '' : approvalHint(o, call)}`.replace(/\s+/g, ' ').trim();
}

/** Produce the agent-specific hook response. Decisions the agent cannot express become deny. */
export function render(agent: AgentId, call: Call | undefined, outcome: Outcome): Output {
  let decision = outcome.decision;
  const event = call?.event;
  const askUnsupported = decision === 'ask' && !canAsk(agent, event);
  if (askUnsupported) decision = 'deny';
  const reason = explain({ ...outcome, decision: outcome.decision }, call, askUnsupported);

  switch (agent) {
    case 'claude': {
      if (decision === 'deny') return { stdout: '', stderr: reason + '\n', code: 2 };
      if (decision === 'ask') {
        return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }) + '\n', stderr: '', code: 0 };
      }
      if (outcome.explicit) {
        return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: outcome.message || 'allowed by ai-rules' } }) + '\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    }
    case 'cursor': {
      if (decision === 'deny') {
        return { stdout: JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason }) + '\n', stderr: reason + '\n', code: 2 };
      }
      if (decision === 'ask') return { stdout: JSON.stringify({ permission: 'ask', user_message: reason, agent_message: reason }) + '\n', stderr: '', code: 0 };
      return { stdout: JSON.stringify({ permission: 'allow' }) + '\n', stderr: '', code: 0 };
    }
    case 'gemini': {
      if (decision === 'deny') return { stdout: '', stderr: reason + '\n', code: 2 };
      return { stdout: outcome.explicit ? JSON.stringify({ decision: 'allow' }) + '\n' : '{}\n', stderr: '', code: 0 };
    }
    case 'windsurf':
    case 'codex': {
      if (decision === 'deny') return { stdout: '', stderr: reason + '\n', code: 2 };
      return { stdout: '', stderr: '', code: 0 };
    }
  }
}

/** Response used when the guard itself fails: always a block. */
export function renderFailure(agent: AgentId | undefined, message: string): Output {
  const reason = `[ai-rules] guard error: ${message}. The action was blocked. Tell the user to run "ai-rules doctor".`;
  if (agent === 'cursor') {
    return { stdout: JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason }) + '\n', stderr: reason + '\n', code: 2 };
  }
  return { stdout: '', stderr: reason + '\n', code: 2 };
}
