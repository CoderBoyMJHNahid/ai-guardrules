import type { AgentId } from '../guard/normalize.js';

export type SampleKind = 'shell' | 'read' | 'write' | 'mcp';

/** Hook payloads in each agent's documented shape. Used by `doctor` and the contract tests. */
export function samplePayload(agent: AgentId, kind: SampleKind, value: string, root: string): unknown {
  const win = process.platform === 'win32';
  switch (agent) {
    case 'claude':
      if (kind === 'shell') return { session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: win ? 'PowerShell' : 'Bash', tool_input: { command: value } };
      if (kind === 'read') return { session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: value } };
      if (kind === 'write') return { session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: value, content: 'x' } };
      return { session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'mcp__db__query', tool_input: { sql: value } };
    case 'cursor':
      if (kind === 'shell') return { hook_event_name: 'beforeShellExecution', conversation_id: 'c1', workspace_roots: [root], command: value, cwd: root };
      if (kind === 'read') return { hook_event_name: 'beforeReadFile', conversation_id: 'c1', workspace_roots: [root], file_path: value, content: '' };
      if (kind === 'write') return { hook_event_name: 'preToolUse', conversation_id: 'c1', workspace_roots: [root], cwd: root, tool_name: 'Write', tool_input: { path: value, contents: 'x' } };
      return { hook_event_name: 'beforeMCPExecution', conversation_id: 'c1', workspace_roots: [root], tool_name: 'query', mcp_server_name: 'db', tool_input: JSON.stringify({ sql: value }) };
    case 'gemini':
      if (kind === 'shell') return { session_id: 's1', cwd: root, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: value } };
      if (kind === 'read') return { session_id: 's1', cwd: root, hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { file_path: value } };
      if (kind === 'write') return { session_id: 's1', cwd: root, hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: value, content: 'x' } };
      return { session_id: 's1', cwd: root, hook_event_name: 'BeforeTool', tool_name: 'mcp_db_query', tool_input: { sql: value } };
    case 'windsurf':
      if (kind === 'shell') return { agent_action_name: 'pre_run_command', trajectory_id: 't1', tool_info: { command_line: value, cwd: root } };
      if (kind === 'read') return { agent_action_name: 'pre_read_code', trajectory_id: 't1', tool_info: { file_path: value } };
      if (kind === 'write') return { agent_action_name: 'pre_write_code', trajectory_id: 't1', tool_info: { file_path: value } };
      return { agent_action_name: 'pre_mcp_tool_use', trajectory_id: 't1', tool_info: { mcp_server_name: 'db', mcp_tool_name: 'query', mcp_tool_arguments: { sql: value } } };
    case 'codex':
      if (kind === 'shell') return { session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: value } };
      if (kind === 'read') return { session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: value } };
      if (kind === 'write') return { session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Add File: ${value}\n+x\n*** End Patch` } };
      return { session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'mcp__db__query', tool_input: { sql: value } };
  }
}

/** True when a guard response blocks the action, in the agent's own convention. */
export function isBlocked(agent: AgentId, out: { code: number; stdout: string }): boolean {
  if (out.code === 2) return true;
  if (agent === 'cursor') {
    try {
      return (JSON.parse(out.stdout) as { permission?: string }).permission === 'deny';
    } catch {
      return false;
    }
  }
  return false;
}

/** True when the response asks the user for approval. */
export function isAsking(agent: AgentId, out: { code: number; stdout: string }): boolean {
  if (out.code !== 0) return false;
  try {
    const j = JSON.parse(out.stdout) as { permission?: string; hookSpecificOutput?: { permissionDecision?: string } };
    if (agent === 'cursor') return j.permission === 'ask';
    if (agent === 'claude') return j.hookSpecificOutput?.permissionDecision === 'ask';
  } catch {
    /* no output */
  }
  return false;
}
