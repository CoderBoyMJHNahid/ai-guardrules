import type { SimpleCommand } from './shell/model.js';

export interface GitAnalysis {
  /** The git invocation is a read-only command from the allowlist. */
  readOnly: boolean;
  subcommand: string | null;
  /** Why it is not read-only (shown to the agent). */
  reason: string;
  /** Matches a destructive pattern (force push, reset --hard, clean -f, ...). */
  destructive: string | null;
}

/** Global options that are harmless before the subcommand. */
const SAFE_GLOBAL = new Set(['--no-pager', '-P', '--no-optional-locks', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-lazy-fetch', '--version']);

const READ_FLAGS_BRANCH = new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--list', '-l', '--show-current', '--no-color', '--color', '--no-column', '--column', '--no-abbrev', '--abbrev', '-i', '--ignore-case']);
const BRANCH_FILTERS = ['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'];

const BAD_FLAG_PREFIXES = ['--output', '--ext-diff', '--textconv', '--no-index', '--open-files-in-pager', '--exec-path', '--upload-pack', '--receive-pack', '--git-dir', '--work-tree'];

function flagMatches(arg: string, prefixes: string[]): boolean {
  return prefixes.some((p) => arg === p || arg.startsWith(p + '='));
}

export function analyzeGit(cmd: SimpleCommand, allow: string[]): GitAnalysis {
  const args = cmd.args.map((a) => a.value);
  let i = 0;
  let reason = '';
  // Global options
  while (i < args.length && (args[i] as string).startsWith('-')) {
    const a = args[i] as string;
    if (SAFE_GLOBAL.has(a)) {
      i++;
      continue;
    }
    reason = `git global option ${a} is not allowed`;
    return { readOnly: false, subcommand: null, reason, destructive: null };
  }
  const sub = args[i] ?? null;
  if (sub === null) return { readOnly: args.includes('--version'), subcommand: null, reason: 'bare git', destructive: null };
  const rest = args.slice(i + 1);
  const destructive = detectDestructive(sub, rest);

  if (cmd.env.length > 0) {
    return { readOnly: false, subcommand: sub, reason: 'environment variables on git commands are not allowed', destructive };
  }
  if (cmd.args.some((a) => a.dynamic)) {
    return { readOnly: false, subcommand: sub, reason: 'git arguments could not be resolved', destructive };
  }
  if (!allow.includes(sub)) {
    return { readOnly: false, subcommand: sub, reason: `git ${sub} can change the repository and is not allowed`, destructive };
  }
  for (const a of rest) {
    if (flagMatches(a, BAD_FLAG_PREFIXES)) return { readOnly: false, subcommand: sub, reason: `git ${sub} ${a} can write files or run programs`, destructive };
    if (sub === 'grep' && /^-O/.test(a)) return { readOnly: false, subcommand: sub, reason: 'git grep -O runs a program', destructive };
  }
  const positional = rest.filter((a) => !a.startsWith('-'));
  const flags = rest.filter((a) => a.startsWith('-'));
  switch (sub) {
    case 'branch': {
      const hasFilter = flags.some((f) => BRANCH_FILTERS.some((p) => f === p || f.startsWith(p + '='))) || flags.includes('--list') || flags.includes('-l');
      const unknown = flags.filter((f) => !READ_FLAGS_BRANCH.has(f) && !BRANCH_FILTERS.some((p) => f === p || f.startsWith(p + '=')));
      if (unknown.length) return { readOnly: false, subcommand: sub, reason: `git branch ${unknown[0]} changes branches`, destructive };
      if (positional.length && !hasFilter) return { readOnly: false, subcommand: sub, reason: 'git branch <name> creates a branch', destructive };
      break;
    }
    case 'tag': {
      const listing = flags.includes('-l') || flags.includes('--list');
      const unknown = flags.filter((f) => !['-l', '--list', '-n', '--sort', '--contains', '--points-at', '--merged', '--no-merged', '--format', '--column', '--no-column', '--color', '--no-color'].some((p) => f === p || f.startsWith(p + '=') || /^-n\d+$/.test(f)));
      if (unknown.length) return { readOnly: false, subcommand: sub, reason: `git tag ${unknown[0]} changes tags`, destructive };
      if (positional.length && !listing) return { readOnly: false, subcommand: sub, reason: 'git tag <name> creates a tag', destructive };
      break;
    }
    case 'remote': {
      const ok = positional.length === 0 || positional[0] === 'get-url' || (positional[0] === 'show' && positional.length <= 2);
      const badFlag = flags.some((f) => !['-v', '--verbose'].includes(f));
      if (!ok || badFlag) return { readOnly: false, subcommand: sub, reason: 'git remote changes remotes', destructive };
      break;
    }
    case 'config': {
      const readFlags = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope', '--name-only', '--null', '-z', '--local', '--global', '--system', '--worktree', '--bool', '--int', '--path', '--type'];
      const writeFlags = ['--add', '--unset', '--unset-all', '--replace-all', '--edit', '-e', '--rename-section', '--remove-section', '--file', '-f', '--blob'];
      const hasRead = flags.some((f) => ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'].includes(f));
      if (!hasRead || flags.some((f) => writeFlags.includes(f) || (!readFlags.includes(f) && !f.startsWith('--type=')))) {
        return { readOnly: false, subcommand: sub, reason: 'git config can only be used to read values', destructive };
      }
      break;
    }
    default:
  }
  return { readOnly: true, subcommand: sub, reason: '', destructive };
}

function detectDestructive(sub: string, rest: string[]): string | null {
  const has = (f: string): boolean => rest.includes(f);
  const flagLetters = (letters: string): boolean => rest.some((a) => /^-[a-zA-Z]+$/.test(a) && [...letters].some((l) => a.includes(l)));
  switch (sub) {
    case 'push':
      if (has('--force') || has('-f') || rest.some((a) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) || has('--mirror') || has('--delete') || rest.some((a) => /^\+/.test(a) || /^:/.test(a))) {
        return 'git push --force/--mirror/--delete rewrites or deletes remote history';
      }
      return null;
    case 'reset':
      return has('--hard') ? 'git reset --hard discards local changes' : null;
    case 'clean':
      return flagLetters('f') || has('--force') ? 'git clean -f deletes untracked files' : null;
    case 'checkout':
    case 'restore':
      return rest.includes('.') ? `git ${sub} . discards local changes` : null;
    case 'filter-branch':
    case 'filter-repo':
      return 'rewrites history';
    default:
      return null;
  }
}
