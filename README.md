# ai-guardrules

**Stop your AI coding agent from deleting files, leaking secrets or running risky commands. One command, any agent.**

[![npm version](https://img.shields.io/npm/v/ai-guardrules.svg)](https://www.npmjs.com/package/ai-guardrules)
[![license](https://img.shields.io/npm/l/ai-guardrules.svg)](https://github.com/CoderBoyMJHNahid/ai-guardrules/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/ai-guardrules.svg)](https://nodejs.org)
[![CI](https://github.com/CoderBoyMJHNahid/ai-guardrules/actions/workflows/ci.yml/badge.svg)](https://github.com/CoderBoyMJHNahid/ai-guardrules/actions/workflows/ci.yml)

```sh
npx ai-guardrules init
```

Works with Claude Code, Cursor, Gemini CLI, Windsurf, Codex, GitHub Copilot and Cline. Runs on macOS, Linux and Windows. Needs Node 20 or newer. No server, no account, no telemetry: everything lives in your repo, so your whole team gets the same protection after a `git pull`.

## Why you want this

AI coding agents are powerful because they can run shell commands and edit files for you. That is also the risk. An agent can:

- read your `.env` file or SSH keys,
- run `rm -rf`, `git push --force` or `DROP TABLE`,
- wander outside your project folder,
- create or change files you never asked for.

Most tools try to stop this with a rules file ("please do not delete things"). That is only advice, and an agent can ignore it.

`ai-guardrules` does two things:

| | What it is | Can the agent ignore it? |
|---|---|---|
| **Rules** | Text files the agent reads (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, ...) | Yes, it is advice |
| **Hooks** | A small script that runs **before every tool call** and answers `allow`, `ask` or `deny` | No, the action is blocked before it runs |

```
  AI agent wants to run a command or edit a file
                      |
                      v
        .ai-guardrules/guard.mjs checks it
                      |
        +-------------+-------------+
        |             |             |
      allow          ask           deny
   (runs now)   (you approve)   (blocked)
```

You write the setup once. It installs the right files for every agent you use.

## Quick start

```sh
cd your-project
npx ai-guardrules init
```

`init` asks two questions:

1. **Which AI tools do you use here?** Tools it detects are pre-selected.
2. **Which preset?** `strict` (recommended) or `standard`. See [Presets](#presets).

Then it writes the files, replays attack payloads through the new hooks as a self-test, and prints the result. Your last step is to commit what it created (check with `git status`), so teammates get the same guardrails:

```sh
git add -A
git commit -m "Add AI agent guardrails"
```

Other ways to run it:

```sh
npx ai-guardrules init -y          # no questions: detected tools, strict preset
npx ai-guardrules init --all       # every supported agent
npx ai-guardrules init --dry-run   # show what would change, write nothing
npx ai-guardrules doctor           # prove the guard works on this machine
```

You can also install it globally (`npm install -g ai-guardrules`) and then use `ai-guardrules` instead of `npx ai-guardrules`.

## What it looks like in practice

With the default `strict` preset:

| The agent tries to... | Result |
|---|---|
| Read `.env`, `id_rsa`, `*.pem`, `.aws/credentials` | Denied |
| Run `rm -rf node_modules`, `git rm`, `find -delete` | Denied |
| Run `git push`, `git commit`, or any `gh` command | Denied (git is read-only) |
| Run `git status`, `git diff`, `git log` | Allowed |
| Run `DELETE FROM users` or `DROP TABLE users` | Denied, always |
| Run `psql`, `mysql`, `redis-cli`, or call a database tool | Asks you |
| Run `npm test` or any other shell command | Asks you |
| Create a new file | Asks you |
| Edit a file that already exists | Allowed |
| Touch a path outside the project (`../`, `~`, `/etc`) | Denied |
| Edit `.ai-guardrules/` or the agent's hook settings to switch the guard off | Denied |

When something is blocked or asks, you decide:

```sh
ai-guardrules allow "npm test"             # always allow this command
ai-guardrules allow "npm test" --once      # allow it one time
ai-guardrules allow "git push origin main" --for 30m
```

The agent cannot run these commands itself. Approvals are yours.

## Supported agents

| Agent | Protection | What is installed |
|---|---|---|
| Claude Code | **Enforced** | `PreToolUse` hook, `permissions.deny` rules, `CLAUDE.md` |
| Cursor | **Enforced** | `.cursor/hooks.json`, `.cursor/cli.json` deny rules, an always-on rule |
| Gemini CLI | **Enforced** | `BeforeTool` hook, `GEMINI.md` |
| Windsurf (Devin Desktop) | **Enforced** | pre-run, pre-read, pre-write and pre-MCP hooks, an always-on rule |
| Codex | **Enforced** | `PreToolUse` hook, sandbox and approval settings in `.codex/config.toml` |
| GitHub Copilot | Advisory | `.github/copilot-instructions.md` |
| Cline | Advisory | `.clinerules/ai-guardrules.md` |
| Any `AGENTS.md` reader | Advisory | `AGENTS.md` (always written) |

**Enforced** means a hook can block the action before it runs. **Advisory** means the agent is only asked to follow the rules, because that tool has no blocking hook we can rely on. `ai-guardrules status` and `ai-guardrules doctor` label each one.

## Presets

| | `strict` (default) | `standard` |
|---|---|---|
| Secrets (`.env`, keys, credentials) | Blocked | Blocked |
| Destructive commands (`rm -rf /`, force push, `mkfs`, fork bombs) | Blocked | Blocked |
| Database deletes (`DELETE`, `DROP`, `TRUNCATE`, `deleteMany`, `FLUSHALL`) | Blocked | Blocked |
| Tampering with the guard itself | Blocked | Blocked |
| Every shell command | Asks you | Allowed |
| Git | Read-only, `gh` blocked | Allowed |
| Deleting project files | Blocked | Allowed |
| Leaving the project folder | Blocked | Allowed |
| Creating new files | Asks you | Allowed |
| Database clients and database MCP tools | Asks you | Allowed |

**Which one?** Start with `strict` if you let agents run on code you care about. It asks often by design. If the prompts get tiring, approve the commands you trust with `ai-guardrules allow`, or switch to `standard` for secrets and destructive-command protection only.

```sh
npx ai-guardrules init --preset standard
```

## Commands

Add `-C <folder>` to any command to run it against another project. Run `ai-guardrules --help` or `ai-guardrules <command> --help` any time.

### Set up and maintain

| Command | Use it to |
|---|---|
| `ai-guardrules init` | Install into this project. Safe to run again; a second run changes nothing |
| `ai-guardrules status` | See what is installed, whether files were tampered with, active approvals and each guard's mode |
| `ai-guardrules doctor` | Self-test: replay about ten attack payloads per agent through the real hooks |
| `ai-guardrules update` | Refresh the guard after upgrading the package. Keeps your policy and custom files |
| `ai-guardrules remove` | Uninstall everything `ai-guardrules` added. Your own content in shared files stays |
| `ai-guardrules lock` | Accept a hand edit of a guard file by refreshing its integrity hash |

Useful flags:

```sh
ai-guardrules init --tools claude,cursor      # only these agents
ai-guardrules init --preset standard          # lighter preset
ai-guardrules init --dry-run                  # preview
ai-guardrules doctor --ci                     # exit non-zero on problems, for CI
ai-guardrules remove --dry-run                # preview an uninstall
ai-guardrules remove --keep-custom            # uninstall but keep .ai-guardrules/custom/
```

### Approve what was blocked

| Command | Use it to |
|---|---|
| `ai-guardrules allow "<command>"` | Approve a command. Add `--once` for one use or `--for 30m` / `2h` / `1d` for a time limit |
| `ai-guardrules allow "<glob>" --path` | Approve a path outside the project boundary |
| `ai-guardrules allow-create "<glob>"` | Let agents create files that match, for example `docs/**` |
| `ai-guardrules grants list` | See active approvals |
| `ai-guardrules grants revoke <id>` | Remove one approval. Use `--all` to remove every approval |

```sh
ai-guardrules allow "npm test"
ai-guardrules allow-create "docs/**" --for 2h
ai-guardrules grants list
ai-guardrules grants revoke --all
```

A wildcard like `npm test*` never covers chained text. `npm test; rm -rf x` needs its own approval.

Some verdicts are **fixed** and cannot be approved: secrets, database deletes, destructive commands and tampering with the guard. `ai-guardrules allow` warns you if your pattern hits one.

### Tune the protection

```sh
ai-guardrules policy show                    # list every guard and its mode
ai-guardrules policy set newFiles allow      # stop asking before creating files
ai-guardrules policy set commands off        # turn a guard off
```

Modes are `allow`, `ask`, `deny` and `off`. See the [guard table](#guards) for the names.

### Add your own rules, guards and hooks

Everything custom lives in `.ai-guardrules/custom/` and survives `update`.

```sh
# Advice: written into AGENTS.md, CLAUDE.md, GEMINI.md and the other rule files
ai-guardrules rule add "Use pnpm, never npm"
ai-guardrules rule list

# Enforced: block or ask about a command
ai-guardrules guard add --id no-publish --command npm --match "publish*" \
  --decision deny --message "Publishing is done by CI"

# Enforced: protect a file from edits
ai-guardrules guard add --id lockfile --on write --path package.json \
  --decision deny --message "Do not edit package.json"

# Try a guard without running anything
ai-guardrules guard test "npm publish"
ai-guardrules guard test .env --read

# Enforced: run your own script before every shell command
ai-guardrules hook add --id lint-sql --event before-shell --run "node scripts/check-command.mjs"
ai-guardrules hook test lint-sql --command "ls"
```

Rules for custom guards and hooks:

- The worst verdict wins (`deny` beats `ask` beats `allow`).
- A custom `allow` can only relax an `ask`. It can never relax a `deny` or a fixed rule.
- A hook receives the action as JSON on stdin. Exit `0` means no objection. Exit `2`, or printing `{"decision":"deny"}` or `{"decision":"ask"}`, restricts. A crash, timeout, bad output or any other exit code blocks. A hook can never make an action more permitted.

## FAQ

**Does it need a server or an account?** No. It is a CLI that writes files into your repo. The guard is one dependency-free script, `.ai-guardrules/guard.mjs`.

**Can the agent approve things for itself?** No. The guard denies the `ai-guardrules` command and any edit to `.ai-guardrules/`, and the guard files are read-only.

**Is this a sandbox?** No. See [Limits](#limits). For hard isolation, also run the agent in a container or VM.

**Does it work on Windows?** Yes. It analyses bash, zsh, PowerShell and `cmd.exe` commands, and handles drive letters, UNC paths and reserved device names. CI runs on macOS, Ubuntu and Windows.

**Strict mode asks too much.** Approve trusted commands with `ai-guardrules allow`, relax one guard with `ai-guardrules policy set`, or use the `standard` preset.

**How do I upgrade?** `npm install -g ai-guardrules@latest` (or use `npx ai-guardrules@latest`), then `ai-guardrules update` in each project.

**How do I uninstall?** `ai-guardrules remove`. It deletes only what it added.

**Will it overwrite my `AGENTS.md` or settings?** No. Our content sits between `ai-guardrules:start` and `ai-guardrules:end` markers. Everything outside the markers stays exactly as you wrote it, including line endings and JSON comments. Files that existed before are copied to `.ai-guardrules/backups/` once.

## How it resists bypass

- **Fails closed.** If the guard crashes, cannot read its input, cannot find its files or times out, the action is blocked.
- **Integrity lock.** `.ai-guardrules/lock.json` stores SHA-256 hashes of the guard, policy and custom files. Any mismatch blocks everything until you run `ai-guardrules lock` or `ai-guardrules update`.
- **Self-protection.** Agents cannot read or edit `.ai-guardrules/`, the agent hook configs or the rule files, and cannot run `ai-guardrules`.
- **Two locks where possible.** Claude `permissions.deny`, Cursor CLI deny rules and the Codex sandbox are configured too.
- **Real shell analysis, not string matching.** Commands are parsed as bash, PowerShell or cmd. It unwraps `sudo`, `env`, `timeout`, `nohup`, `xargs`, `find -exec`, `npx`, `sh -c`, `cmd /c`, `powershell -EncodedCommand`, `wsl`, `eval`, `source`, heredocs, command substitution, pipes and chains. Quoting tricks such as `r""m` or `c\at .env` are resolved first. Anything it cannot understand is treated as dangerous.
- **Real path resolution.** Symlinks, `..`, `~`, `$HOME`, `%USERPROFILE%` and Windows alternate data streams are resolved before the secret and boundary checks.
- **Inline code is scanned.** `python -c`, `node -e`, `ruby -e`, `perl -e`, `php -r`, `deno eval` and database `-c` / `--eval` strings are checked for deletes, secret reads and escapes.
- **Tested.** Over 2,000 tests, including obfuscated attack corpora, property-based tests and real-process contract tests for each agent.

`ai-guardrules doctor` runs a live version of this on your machine.

## Limits

Please read these before relying on it.

- **No tool can promise a perfect shell sandbox.** A hook sees the command text before it runs. A sufficiently creative command could still evade analysis. That is why unparseable input is denied, why `strict` asks for every command, and why native layers are added.
- **Advisory agents can ignore rules.** Copilot and Cline have no blocking hooks we can rely on.
- **Hook formats are taken from vendor documentation**, checked 2026-10-28, not captured from live sessions. Agents change hook formats. If one does, `doctor` will not know. Please [open an issue](https://github.com/CoderBoyMJHNahid/ai-guardrules/issues) with a captured payload. Details: [docs/agent-schemas.md](https://github.com/CoderBoyMJHNahid/ai-guardrules/blob/main/docs/agent-schemas.md).
- **Hooks use a relative path** (`node .ai-guardrules/guard.mjs`). If an agent starts hooks from another folder, the script is not found. Claude and Cursor then block. Gemini, Windsurf and Codex treat only exit `2` as a block, so a missing script there may fail open. Claude users can run `ai-guardrules init --local-wrapper` for a stricter machine-local wrapper.
- **Codex asks you to trust new hooks once.** Run `/hooks` in Codex after `init`.
- **You can always turn it off.** `ai-guardrules remove`, or `disableAllHooks` in an agent's settings. The guardrails stop the agent, not you.
- **Strict is noisy by design.** See the FAQ.

## Reference

### Guards

`ai-guardrules policy show` lists every guard. Change one with `ai-guardrules policy set <guard> <allow|ask|deny|off>`.

| Guard | What it covers | strict | standard | Can be relaxed? |
|---|---|:---:|:---:|:---:|
| `commands` | Every shell command | ask | off | yes |
| `git` | Read-only git allowlist, no `gh` | deny | off | yes |
| `database` | Database clients and database MCP tools | ask | off | yes |
| `fileDelete` | `rm`, `unlink`, `git rm`, `find -delete`, `Remove-Item`, `shutil.rmtree`, ... | deny | off | yes |
| `boundary` | Paths outside the project | deny | off | yes |
| `newFiles` | Creating files | ask | off | yes |
| `interpreters` | Inline `python -c`, `node -e`, ... | ask | off | yes |
| `unknownTools` | Tools and MCP calls the guard does not know | ask | off | yes |
| `unparseable` | Commands that cannot be analysed | deny | off | yes |
| `symlinks` | Creating links | deny | off | yes |
| `databaseDelete` | SQL `DELETE`/`DROP`/`TRUNCATE`, Mongo `deleteMany`/`drop`, Redis `FLUSHALL` | deny | deny | never |
| `secrets` | `.env*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`, SSH keys, `.aws/credentials`, `.netrc`, `secrets/**` | deny | deny | never |
| `destructive` | `rm -rf /`, `git push --force`, `mkfs`, `dd` to a device, fork bombs | deny | deny | never |
| `selfProtection` | `.ai-guardrules/`, hook configs and rule files | deny | deny | never |

Git commands allowed in `strict`: `status`, `log`, `diff`, `show`, `blame`, `branch` (list), `rev-parse`, `ls-files`, `ls-tree`, `cat-file`, `grep`, `describe`, `shortlog`, `rev-list`, `merge-base`, `show-ref`, `remote -v`, `tag -l`, `config --get`, `check-ignore`.

### Ask support per agent

When a hook cannot ask, the action is blocked and you approve it with `ai-guardrules allow`. Then the agent can retry.

| Agent | Can the hook ask you? |
|---|---|
| Claude Code | Yes |
| Cursor | Shell and MCP calls. Elsewhere `ask` becomes `deny` |
| Gemini CLI, Windsurf, Codex | No. `ask` becomes `deny` |

### Operating systems

| | macOS | Linux | Windows |
|---|:---:|:---:|:---:|
| CLI and guard | yes | yes | yes |
| bash / zsh / sh analysis | yes | yes | yes (Git Bash and WSL commands are unwrapped) |
| PowerShell analysis | yes (`pwsh`) | yes (`pwsh`) | yes |
| `cmd.exe` analysis | yes | yes | yes |
| Case-insensitive paths | yes | no | yes |
| Read-only guard files | `chmod 444` | `chmod 444` | read-only attribute |

### Files `init` creates

```
.ai-guardrules/
  guard.mjs            the enforcement script (zero dependencies, read-only)
  policy.json          guard modes (read-only)
  lock.json            integrity hashes (read-only)
  manifest.json        what was installed, so remove is exact
  grants.json          your approvals
  custom/              your own rules, guards and hooks
  backups/             one-time copies of files that existed before
```

Plus, depending on the agents you pick: `.claude/settings.json`, `.cursor/hooks.json`, `.cursor/cli.json`, `.cursor/rules/ai-guardrules.mdc`, `.gemini/settings.json`, `.devin/hooks.json`, `.codex/hooks.json`, `.codex/config.toml`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.clinerules/ai-guardrules.md`, `.windsurf/rules/ai-guardrules.md`, and managed blocks in `.gitignore` and `.gitattributes`.

### Tested versions

| Agent | Documented schema checked | Live capture |
|---|---|:---:|
| Claude Code | 2026-10-28 | no |
| Cursor | 2026-10-28 | no |
| Gemini CLI | 2026-10-28 | no |
| Windsurf / Devin Desktop | 2026-10-28 | no |
| Codex | 2026-10-28 | no |

## Contributing and development

```sh
git clone https://github.com/CoderBoyMJHNahid/ai-guardrules.git
cd ai-guardrules
npm install
npm run build        # dist/cli.js and the standalone dist/guard.mjs
npm test             # vitest
npm run typecheck
```

Bug reports and captured agent hook payloads are welcome in the [issue tracker](https://github.com/CoderBoyMJHNahid/ai-guardrules/issues).

## License

[MIT](https://github.com/CoderBoyMJHNahid/ai-guardrules/blob/main/LICENSE)
