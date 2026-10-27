import path from 'node:path';
import { Command } from 'commander';
import { runGuardAdd, runGuardList, runGuardRemove, runGuardTest, runHookAdd, runHookList, runHookRemove, runHookTest, runRuleAdd, runRuleList, runRuleRemove } from './commands/custom.js';
import { runDoctorCommand } from './commands/doctor.js';
import { runAllow, runAllowCreate, runGrantsList, runGrantsRevoke } from './commands/grants.js';
import { runInit } from './commands/init.js';
import { runLock, runRemove, runStatus, runUpdate } from './commands/maintain.js';
import { runPolicySet, runPolicyShow } from './commands/policy.js';
import { packageVersion } from './core/project.js';
import { CliError, out, pc } from './ui.js';

const program = new Command();
program
  .name('ai-rules')
  .description('Shared rules, enforced hooks and guardrails for AI coding agents')
  .version(packageVersion(), '-v, --version')
  .option('-C, --dir <path>', 'project folder (default: current folder)')
  .showHelpAfterError();

const root = (): string => path.resolve(program.opts<{ dir?: string }>().dir ?? process.cwd());

function wrap<A extends unknown[]>(fn: (...args: A) => void | Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      if (e instanceof CliError) {
        out.line(pc.red(e.message));
        process.exitCode = e.exitCode;
      } else {
        out.line(pc.red(e instanceof Error ? e.message : String(e)));
        process.exitCode = 1;
      }
    }
  };
}

// --- setup and maintenance ---------------------------------------------------------------

program
  .command('init')
  .description('Install rules, hooks and guardrails in this project')
  .option('--tools <list>', 'comma-separated: claude,cursor,gemini,windsurf,codex,copilot,cline,agents')
  .option('--preset <name>', 'strict (default) or standard')
  .option('--all', 'install for every supported tool')
  .option('-y, --yes', 'do not ask questions; use detected tools and defaults')
  .option('--dry-run', 'show what would change without writing')
  .option('--force', 'fix settings that disable hooks')
  .option('--local-wrapper', 'Claude only: write a stricter machine-local hook wrapper')
  .action(wrap((o) => runInit(root(), o)));

program
  .command('update')
  .description('Refresh the guard and managed content after upgrading; keeps your policy and custom files')
  .option('--dry-run', 'show what would change without writing')
  .option('--force', 'fix settings that disable hooks')
  .action(wrap((o) => runUpdate(root(), o)));

program.command('lock').description('Trust hand-made edits: refresh the integrity hashes').action(wrap(() => runLock(root())));

program
  .command('remove')
  .description('Uninstall everything ai-rules added')
  .option('-y, --yes', 'do not ask for confirmation')
  .option('--dry-run', 'show what would be removed')
  .option('--keep-custom', 'keep .ai-rules/custom/')
  .option('--all', 'try every tool, not only the installed ones')
  .action(wrap((o) => runRemove(root(), o)));

program.command('status').description('Show what is installed and the current guard modes').action(wrap(() => runStatus(root())));

program
  .command('doctor')
  .description('Verify the installation and replay attack payloads through the hooks')
  .option('--ci', 'exit non-zero on any critical problem (for CI)')
  .action(wrap((o) => runDoctorCommand(root(), o)));

// --- policy -------------------------------------------------------------------------------

const policy = program.command('policy').description('View or change guard modes');
policy.command('show').description('List every guard and its mode').action(wrap(() => runPolicyShow(root())));
policy
  .command('set <guard> <mode>')
  .description('Set a guard to allow, ask, deny or off (secrets, databaseDelete, destructive and selfProtection are fixed)')
  .action(wrap((guard: string, mode: string) => runPolicySet(root(), guard, mode)));

// --- approvals ----------------------------------------------------------------------------

program
  .command('allow <pattern>')
  .description('Approve a blocked command (or a path with --path). Run this yourself; agents cannot')
  .option('--once', 'valid for a single use')
  .option('--for <duration>', 'expires after e.g. 30m, 2h, 1d')
  .option('--path', 'the pattern is a path glob (for the project-boundary guard)')
  .action(wrap((pattern: string, o) => runAllow(root(), pattern, o)));

program
  .command('allow-create <pattern>')
  .description('Approve creating files that match a path glob')
  .option('--once', 'valid for a single use')
  .option('--for <duration>', 'expires after e.g. 30m, 2h, 1d')
  .action(wrap((pattern: string, o) => runAllowCreate(root(), pattern, o)));

const grants = program.command('grants').description('Manage approvals');
grants.command('list').description('Show active approvals').action(wrap(() => runGrantsList(root())));
grants
  .command('revoke [id]')
  .description('Remove an approval')
  .option('--all', 'remove every approval')
  .action(wrap((id: string | undefined, o) => runGrantsRevoke(root(), id, o)));

// --- customisation ---------------------------------------------------------------------------

const rule = program.command('rule').description('Your own rules for agents (written to AGENTS.md and the other rule files)');
rule.command('add <text>').description('Add a rule').action(wrap((text: string) => runRuleAdd(root(), text)));
rule.command('list').description('List your rules').action(wrap(() => runRuleList(root())));
rule.command('remove <number-or-text>').description('Remove a rule').action(wrap((which: string) => runRuleRemove(root(), which)));

const guard = program.command('guard').description('Your own enforced guards (can only be stricter than the preset)');
guard
  .command('add')
  .description('Add a guard')
  .requiredOption('--id <id>', 'short name')
  .requiredOption('--message <text>', 'why it triggers (shown to the agent)')
  .option('--on <kind>', 'shell, read, write, edit, mcp or any', 'shell')
  .option('--command <name>', 'command name (shell) or tool name glob (mcp)')
  .option('--match <glob>', 'glob matched against the arguments')
  .option('--path <glob>', 'path glob, relative to the project root')
  .option('--decision <mode>', 'ask, deny, allow (only relaxes ask) or off', 'deny')
  .action(wrap((o) => runGuardAdd(root(), o)));
guard.command('list').description('List your guards').action(wrap(() => runGuardList(root())));
guard.command('remove <id>').description('Remove a guard').action(wrap((id: string) => runGuardRemove(root(), id)));
guard
  .command('test <input>')
  .description('See what the guard would decide for a command (or a path with --read/--write/--delete)')
  .option('--read', 'treat input as a file read')
  .option('--write', 'treat input as a file write')
  .option('--delete', 'treat input as a file delete')
  .option('--powershell', 'parse the command as PowerShell')
  .option('--cmd', 'parse the command as cmd.exe')
  .action(wrap((input: string, o) => runGuardTest(root(), input, o)));

const hook = program.command('hook').description('Your own hook scripts, run by the guard before each action (can only be stricter)');
hook
  .command('add')
  .description('Add a hook')
  .requiredOption('--id <id>', 'short name')
  .requiredOption('--run <command>', 'command to run; receives the action as JSON on stdin')
  .option('--event <event>', 'before-shell, before-read, before-write, before-mcp or any', 'before-shell')
  .option('--timeout <ms>', 'timeout in milliseconds (100-30000)')
  .action(wrap((o) => runHookAdd(root(), o)));
hook.command('list').description('List your hooks').action(wrap(() => runHookList(root())));
hook.command('remove <id>').description('Remove a hook').action(wrap((id: string) => runHookRemove(root(), id)));
hook
  .command('test <id>')
  .description('Run a hook with a sample action')
  .option('--command <text>', 'sample shell command')
  .option('--file <path>', 'sample file write instead of a shell command')
  .action(wrap((id: string, o) => runHookTest(root(), id, o)));

await program.parseAsync(process.argv);
