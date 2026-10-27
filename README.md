# ai-rules

One command to put shared rules, **enforced** hooks and guardrails in a project, for every popular AI coding agent.

```sh
npx ai-rules init
```

It works on macOS, Linux and Windows, needs Node 20 or newer, and has no runtime service. Everything it installs lives in your repo, so your team gets the same protection after a `git pull`.

## What it does

For each agent you choose, `init` writes two things:

1. **Rules** the agent reads (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/`, ...). These are advice. An agent can ignore them.
2. **Hooks** that run a small script (`.ai-rules/guard.mjs`) before every tool call. The script decides **allow**, **ask** or **deny**. This is enforcement. The agent cannot talk its way past it.

The default preset, `strict`, implements these six rules:

| # | Rule | How it is enforced |
|---|------|--------------------|
| 1 | No command runs without your approval | Every shell command asks (read-only git is allowed without a prompt) |
| 2 | Git is read-only, `gh` is blocked | Allowlist: `status`, `log`, `diff`, `show`, `blame`, `branch` (list), `rev-parse`, `ls-files`, `ls-tree`, `cat-file`, `grep`, `describe`, `shortlog`, `rev-list`, `merge-base`, `show-ref`, `remote -v`, `tag -l`, `config --get`, `check-ignore`. Everything else, and the whole `gh` CLI, is denied |
| 3 | Never delete in a database; no database access without approval | SQL `DELETE`/`DROP`/`TRUNCATE`, Mongo `deleteMany`/`drop`, Redis `FLUSHALL` and similar are **always** denied. Database clients and database MCP tools ask |
| 4 | Never delete a project file | `rm`, `unlink`, `rmdir`, `git rm`, `find -delete`, `shutil.rmtree`, `fs.rm`, PowerShell `Remove-Item`, `del`, ... are denied |
| 5 | Stay inside the project folder | Paths are resolved (symlinks, `..`, `~`, env variables, Windows drives, UNC, ADS) and anything outside is denied |
| 6 | No new files without approval | Creating a file asks. Editing an existing file is free |

The `standard` preset is lighter: it only enforces the four fixed guards (secrets, destructive commands, database deletes and protection of the guard files). All other guards are off.

Secrets (`.env*` except `.env.example`, `*.pem`, `*.key`, `*.p12`, SSH private keys, `.aws/credentials`, `.netrc`, `secrets/**`) and destructive commands (`rm -rf /`, `git push --force`, `mkfs`, `dd` to a device, fork bombs, ...) are blocked in **both** presets.

## Quick start

```sh
npx ai-rules init            # asks which agents and which preset (strict is the default)
npx ai-rules init -y         # no questions: detected agents, strict
npx ai-rules init --all      # every supported agent
npx ai-rules doctor          # replays attack payloads through the installed hooks
```

Commit `.ai-rules/` and the generated hook configs.

## Commands

| Command | What it does |
|---------|--------------|
| `init [--tools a,b] [--preset strict\|standard] [--all] [-y] [--dry-run] [--force] [--local-wrapper]` | Install. Safe to run again; the second run changes nothing |
| `update` | Refresh the guard after upgrading the package. Keeps your policy and custom files |
| `lock` | Trust a hand edit to a guard file by refreshing the integrity hashes |
| `remove [-y] [--keep-custom] [--all] [--dry-run]` | Uninstall everything we added. Your own content in shared files is kept |
| `status` | What is installed, the integrity state, active grants and each guard mode |
| `doctor [--ci]` | Self-test: replays about ten attack payloads per agent through the real hook and checks the guard fails closed |
| `policy show` / `policy set <guard> <allow\|ask\|deny\|off>` | Change a guard mode |
| `allow <pattern> [--once] [--for 30m] [--path]` | Approve a blocked or asked command (or a path glob) |
| `allow-create <glob> [--once] [--for 2h]` | Approve creating files that match a glob |
| `grants list` / `grants revoke <id> \| --all` | Manage approvals |
| `rule add\|list\|remove` | Your own rules, written into every agent's rule file |
| `guard add\|list\|remove\|test` | Your own enforced guards (can only make things stricter) |
| `hook add\|list\|remove\|test` | Your own hook scripts, run by the guard (can only make things stricter) |

Use `-C <dir>` to run against another folder.

### Approving things

Approvals are **yours**. The guard denies the `ai-rules` command itself and edits to `.ai-rules/`, so an agent cannot approve itself.

```sh
ai-rules allow "npm test"                 # until you revoke it
ai-rules allow "npm test" --once          # one use, used up only if the action really runs
ai-rules allow "git push origin main" --for 30m
ai-rules allow-create "docs/**"           # let agents create files under docs/
ai-rules grants list
ai-rules grants revoke <id>
```

A wildcard grant such as `npm test*` never covers chained text. `npm test; rm -rf x` needs its own approval.

Some verdicts are **fixed** and a grant does nothing for them: secrets, database deletes, destructive commands and tampering with the guard. `ai-rules allow` warns you when a pattern hits one of these.

### Your own rules, guards and hooks

Everything custom lives in `.ai-rules/custom/` and survives `update`.

```sh
# Advice for agents, written to AGENTS.md, CLAUDE.md, GEMINI.md and the others
ai-rules rule add "Use pnpm, never npm"

# Enforced: block a command
ai-rules guard add --id no-publish --command npm --match "publish*" \
  --decision deny --message "Publishing is done by CI"

# Enforced: protect a file from edits
ai-rules guard add --id lockfile --on write --path package.json \
  --decision deny --message "Do not edit package.json"

# Enforced: run your own script before each shell command
ai-rules hook add --id lint-sql --event before-shell --run "node scripts/check-command.mjs"
ai-rules hook test lint-sql --command "ls"
```

Rules for customisation:

- The worst verdict wins (`deny` beats `ask` beats `allow`).
- A custom `allow` can only relax a preset `ask`. It can never relax a `deny`, and never a fixed rule.
- A hook gets the action as JSON on stdin. Exit `0` means no objection. Exit `2`, or printing `{"decision":"deny"}` or `{"decision":"ask"}`, restricts. **A crash, timeout, bad output or any other exit code blocks.** A hook can never make an action more permitted.

## Presets and guards

`ai-rules policy show` lists every guard.

| Guard | strict | standard | Can be relaxed? |
|-------|:------:|:--------:|:---------------:|
| `commands` (every shell command) | ask | off | yes |
| `git` (read-only allowlist, no `gh`) | deny | off | yes |
| `database` (clients, database MCP) | ask | off | yes |
| `fileDelete` | deny | off | yes |
| `boundary` (outside the project) | deny | off | yes |
| `newFiles` | ask | off | yes |
| `interpreters` (inline `python -c`, `node -e`) | ask | off | yes |
| `unknownTools` | ask | off | yes |
| `unparseable` (commands we cannot analyse) | deny | off | yes |
| `symlinks` | deny | off | yes |
| `databaseDelete` | deny | deny | **never** |
| `secrets` | deny | deny | **never** |
| `destructive` | deny | deny | **never** |
| `selfProtection` | deny | deny | **never** |

## Enforced vs advisory

"Enforced" means a hook can block the action before it runs. "Advisory" means the agent is only asked to follow rules.

| Agent | Level | What is installed | `ask` supported by the hook? |
|-------|-------|-------------------|------------------------------|
| Claude Code | **enforced** | `PreToolUse` hook (`onFailure: block`), native `permissions.deny` rules, `CLAUDE.md` | yes |
| Cursor | **enforced** | `hooks.json` (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `preToolUse`; all `failClosed`), `.cursor/cli.json` deny rules, always-on rule | shell and MCP only. Elsewhere `ask` becomes `deny` |
| Gemini CLI | **enforced** | `BeforeTool` hook, `GEMINI.md` | no. `ask` becomes `deny` |
| Windsurf (Devin Desktop) | **enforced** | pre-run, pre-read, pre-write and pre-MCP hooks, always-on rule | no. `ask` becomes `deny` |
| Codex | **enforced** | `PreToolUse` hook, `approval_policy` and `workspace-write` sandbox in `.codex/config.toml` | no. `ask` becomes `deny` |
| GitHub Copilot | advisory | `.github/copilot-instructions.md` | n/a |
| Cline | advisory | `.clinerules/ai-rules.md` | n/a |
| `AGENTS.md` | advisory | canonical rules read by Codex, Cursor, Copilot, Windsurf and others | n/a |

When a hook cannot ask, the action is blocked and you approve it with `ai-rules allow`. Then the agent can retry.

### Operating systems

| | macOS | Linux | Windows |
|---|:---:|:---:|:---:|
| CLI and guard | yes | yes | yes |
| bash / zsh / sh analysis | yes | yes | yes (Git Bash, WSL commands are unwrapped) |
| PowerShell analysis | yes (`pwsh`) | yes (`pwsh`) | yes |
| `cmd.exe` analysis | yes | yes | yes |
| Case-insensitive paths | yes | no | yes |
| Windows paths (drive letters, UNC, ADS, reserved device names) | yes | yes | yes |
| Read-only guard files | `chmod 444` | `chmod 444` | read-only attribute (via Node `chmod`) |

The CI workflow runs the full suite on macOS, Ubuntu and Windows with Node 20 and 22.

## How it is hard to bypass

- **Fail closed.** If the guard crashes, cannot parse its input, cannot find its files, or times out, the action is blocked. Claude uses `onFailure: block` and Cursor uses `failClosed`.
- **Integrity lock.** `.ai-rules/lock.json` stores SHA-256 hashes of the guard, policy and custom files (line endings are normalised so git autocrlf does not trip it). Any mismatch, a missing or unreadable lock, or a new unlocked file blocks **everything** until you run `ai-rules lock` or `ai-rules update`.
- **Self-protection.** Agents cannot read or edit `.ai-rules/`, the agent hook configs, or rule files, and cannot run `ai-rules`. The files are also marked read-only.
- **Native layers.** Where an agent has its own permission system (Claude `permissions.deny`, Cursor CLI deny rules, Codex sandbox) we configure it too, so there are two independent locks.
- **Shell analysis, not string matching.** Commands are parsed as bash, PowerShell or cmd. We unwrap `sudo`, `env`, `timeout`, `nohup`, `xargs`, `find -exec`, `npx`, `sh -c`, `cmd /c`, `powershell -EncodedCommand`, `wsl`, `eval`, `source`, heredocs, here-strings, command substitution, pipes and chains. Quoting tricks (`r""m`, `c\at .env`) are resolved before matching. Anything we cannot resolve is treated as dangerous (`unparseable`), not allowed.
- **Real path resolution.** Symlinks, `..`, `~`, `$HOME`, `%USERPROFILE%`, Windows alternate data streams (`.env::$DATA`) and device or reserved names are resolved before the boundary and secret checks.
- **Inline code.** `python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `deno eval` and database `-c`/`--eval` strings are scanned for deletes, secret reads and escapes.
- **Tests.** About 2,150 tests, including an adversarial corpus of obfuscated attacks, property-based tests (random wrapper stacks, quote noise, random strings must never crash or allow), and real-process contract tests for each agent.

`ai-rules doctor` runs a live version of this on your machine.

## Limits (please read)

- **No tool can promise a perfect shell sandbox.** A hook sees the command text before it runs. A sufficiently creative command could still evade analysis. That is why unparseable input is denied, why `strict` asks for every command, and why we add native layers. For hard isolation, run the agent in a container or VM as well.
- **Advisory agents can ignore rules.** Copilot and Cline have no blocking hooks we can rely on. Their files are guidance only. `doctor` and `status` label them as advisory.
- **Hook fixtures come from documentation.** The payload shapes in `docs/agent-schemas.md` were taken from each vendor's public docs (checked 2026-10-28), not captured from live agent sessions. Agents change hook formats. If one does, `doctor` or the contract tests will not know. Please open an issue with a captured payload.
- **The hook path is relative.** Hooks run `node .ai-rules/guard.mjs`, relative to the project. If an agent starts hooks from another working directory, the script is not found. Claude and Cursor then block (fail closed). Gemini, Windsurf and Codex only treat exit `2` as a block, so a missing script there may fail open. Claude users can run `init --local-wrapper` to write a stricter machine-local wrapper to `.claude/settings.local.json`.
- **Codex asks you to trust new hooks once.** Run `/hooks` in Codex after `init`.
- **A user can always turn it off.** `ai-rules remove`, or `disableAllHooks` in an agent's settings (enterprise managed settings can forbid that). The guardrails stop the agent, not you.
- **Strict is noisy by design.** Every command asks. If that is too much, use `ai-rules allow` for the commands you trust, or choose `standard`.

## Tested versions

| Agent | Documented schema checked | Live capture |
|-------|---------------------------|:------------:|
| Claude Code | 2026-10-28 | no |
| Cursor | 2026-10-28 | no |
| Gemini CLI | 2026-10-28 | no |
| Windsurf / Devin Desktop | 2026-10-28 | no |
| Codex | 2026-10-28 | no |

## Files `init` creates

```
.ai-rules/
  guard.mjs            the enforcement script (zero dependencies, read-only)
  policy.json          guard modes (read-only)
  lock.json            integrity hashes (read-only)
  manifest.json        what we installed, so remove is exact
  grants.json          your approvals
  custom/              your own rules, guards and hooks
  backups/             one-time copies of files that existed before we touched them
```

Plus, depending on the agents: `.claude/settings.json`, `.cursor/hooks.json`, `.cursor/cli.json`, `.cursor/rules/ai-rules.mdc`, `.gemini/settings.json`, `.devin/hooks.json`, `.codex/hooks.json`, `.codex/config.toml`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.clinerules/ai-rules.md`, `.windsurf/rules/ai-rules.md`, and managed blocks in `.gitignore` and `.gitattributes`.

Our content in shared files sits between `ai-rules:start` and `ai-rules:end` markers. Everything outside the markers is left exactly as you wrote it, including line endings and JSON comments.

## Development

```sh
npm install
npm run build        # dist/cli.js and the standalone dist/guard.mjs
npm test             # vitest (builds first)
npm run typecheck
```

Publishing runs `typecheck`, `build` and the tests through `prepublishOnly`, with npm provenance enabled.

## License

MIT
