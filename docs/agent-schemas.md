# Agent hook schemas (spike notes)

Verified against each vendor's public docs on 2026-10-28. Payload fixtures in
`src/core/samples.ts` (used by `doctor` and the contract tests) are built from these documented shapes, not captured from live
agent runs. Re-capture them when an agent releases a new hook schema.

## Claude Code

- Config: `.claude/settings.json` -> `hooks.PreToolUse[]` = `{ matcher, hooks: [{ type: "command", command, args?, onFailure? }] }`.
- `matcher` is a regex on the tool name. `.*` matches every tool (including MCP: `mcp__server__tool`).
- Exec form (`command: "node"`, `args: [...]`) spawns without a shell, so it works on macOS, Linux and Windows with one committed config. Requires a recent Claude Code.
- `onFailure: "block"` turns a hook crash, timeout, bad output or a missing script into a block (needs Claude Code v2.1.295+). Without it a failing hook fails open.
- Input (stdin JSON): `session_id`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`.
  - `Bash` / `PowerShell`: `tool_input.command`.
  - `Write` / `Edit` / `Read`: `tool_input.file_path` (always absolute, backslashes on Windows).
  - `Glob` / `Grep`: `tool_input.path`, `pattern`, `glob`.
- Output: exit 0 + `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask","permissionDecisionReason":"..."}}`, or exit 2 + stderr to block. Any other exit code is a non-blocking error.
- `"allow"` skips the permission prompt, so the guard only emits it for explicitly allowlisted actions. Everything else prints nothing and Claude's normal permission flow continues.
- `permissions.deny` / `permissions.ask` in settings are enforced by Claude itself, independent of hooks.
- `disableAllHooks: true` in any settings file turns hooks off (managed settings cannot be overridden).

## Cursor

- Config: `.cursor/hooks.json` -> `{ "version": 1, "hooks": { "<event>": [{ command, matcher?, timeout?, failClosed? }] } }`.
- Events used: `beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse`.
- `failClosed: true` blocks the action on crash, timeout, non-zero exit or no output.
- Input: base fields (`hook_event_name`, `workspace_roots`, `cursor_version`, `conversation_id`, ...) plus
  - `beforeShellExecution`: `command`, `cwd`, `sandbox`.
  - `beforeMCPExecution`: `tool_name`, `tool_input` (JSON string), `mcp_server_name`.
  - `beforeReadFile`: `file_path`, `content`.
  - `preToolUse`: `tool_name` (`Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task`, `MCP:<name>`), `tool_input`, `cwd`.
- Output JSON: `{ "permission": "allow|deny|ask", "user_message", "agent_message" }`. Exit code 2 also denies. Invalid or missing JSON from a permission hook blocks.
- `ask` is enforced for `beforeShellExecution` and `beforeMCPExecution`. It is **not** enforced for `preToolUse` and `beforeReadFile` (only allow/deny), so the guard converts `ask` to `deny` there.
- Rules: `.cursor/rules/*.mdc` with front matter (`alwaysApply: true`). Cursor also reads `AGENTS.md`.

## Gemini CLI

- Config: `.gemini/settings.json` -> `hooks.BeforeTool[]` = `{ matcher, hooks: [{ type: "command", command, name, timeout(ms) }] }`.
- Input: `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`. Tool names: `run_shell_command`, `read_file`, `write_file`, `replace`, `read_many_files`, `glob`, `search_file_content`/`grep_search`, `list_directory`, MCP: `mcp_<server>_<tool>`.
- Output: exit 2 + stderr blocks, or exit 0 + `{"decision":"deny","reason":"..."}`. There is no `ask`, so `ask` becomes `deny`. Other non-zero exit codes are warnings (fail open).
- Context: `GEMINI.md` supports `@file` imports.

## Windsurf (now Devin Desktop)

- Config: `.devin/hooks.json` (legacy `.windsurf/hooks.json` is used when `.devin/hooks.json` is absent). Shape: `{ "hooks": { "<event>": [{ command, powershell?, show_output?, working_directory? }] } }`.
- `command` runs via `bash -c` on macOS/Linux, `powershell` (or `command` as fallback) via `powershell -Command` on Windows.
- Pre-hooks: `pre_read_code` (`tool_info.file_path`), `pre_write_code` (`tool_info.file_path`), `pre_run_command` (`tool_info.command_line`), `pre_mcp_tool_use`. Input has `agent_action_name`.
- Exit 2 blocks (stderr is the reason). No `ask`.
- Rules: `.windsurf/rules/*.md`.

## Codex

- Hooks: `.codex/hooks.json`, Claude-style (`PreToolUse` with `matcher`, `type: "command"`). Matchers: `Bash`, `apply_patch` (also `Edit`/`Write`), MCP names. Non-managed hooks must be reviewed and trusted once via `/hooks`.
- Output: `hookSpecificOutput.permissionDecision: "deny"` (or exit 2). `ask` is parsed but unsupported, so `ask` becomes `deny`.
- `apply_patch` puts the patch text in `tool_input.command` (`*** Add File: path`, `*** Update File:`, `*** Delete File:`); the guard parses file paths from it.
- Native layer: `.codex/config.toml` with `approval_policy` and `sandbox_mode = "workspace-write"` keeps writes inside the workspace.
- Reads `AGENTS.md`.

## Copilot, Cline

- No blocking hooks relied on. Rules only:
  - Copilot: `.github/copilot-instructions.md` (also reads `AGENTS.md`).
  - Cline: `.clinerules/*.md`.

## npm name

`ai-rules` returned 404 on the registry on 2026-10-28 (unclaimed). `ai-guardrails` is taken by an unrelated package. Publishing needs `npm login`; no placeholder was published from this environment.
