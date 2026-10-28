import type { PresetName } from '../core/rules-text.js';

/**
 * Native permission rules each agent enforces itself, independent of hooks.
 * They are a second layer: if a hook fails to run, these still apply.
 */

const SECRET_READ = ['./.env', './.env.local', './.env.production', './.env.development', './.env.test', './secrets/**', '**/*.pem', '**/*.key', '**/id_rsa', '**/id_ed25519', '**/id_ecdsa'];
const GUARD_FILES = ['./.ai-guardrules/**', './.claude/settings.json', './.claude/settings.local.json', './.cursor/hooks.json', './.gemini/settings.json', './.devin/hooks.json', './.windsurf/hooks.json', './.codex/hooks.json', './.codex/config.toml', './AGENTS.md', './CLAUDE.md', './GEMINI.md'];

const DENIED_GIT = ['add', 'commit', 'push', 'pull', 'fetch', 'checkout', 'switch', 'reset', 'restore', 'stash', 'rebase', 'merge', 'clean', 'rm', 'mv', 'cherry-pick', 'revert', 'apply', 'am', 'init', 'clone'];

function bash(cmd: string): string[] {
  return [`Bash(${cmd})`, `Bash(${cmd} *)`];
}

export function claudeDeny(preset: PresetName): string[] {
  const out: string[] = [];
  out.push(...SECRET_READ.map((p) => `Read(${p})`));
  out.push(...GUARD_FILES.map((p) => `Edit(${p})`));
  out.push(...bash('ai-guardrules'), ...bash('npx ai-guardrules'));
  if (preset === 'standard') {
    out.push('Bash(git push --force *)', 'Bash(git push -f *)', 'Bash(git reset --hard *)', 'Bash(git clean *)', 'Bash(rm -rf /*)', 'Bash(rm -rf ~*)', 'Bash(sudo rm *)');
  } else {
    for (const g of DENIED_GIT) out.push(...bash(`git ${g}`));
    out.push(...bash('gh'), ...bash('rm'), ...bash('rmdir'), ...bash('unlink'), ...bash('shred'), ...bash('sudo'));
  }
  return out;
}

/** Every rule this tool may have added for any preset, so uninstall and preset changes can clean up. */
export function claudeDenyAll(): string[] {
  return [...new Set([...claudeDeny('standard'), ...claudeDeny('strict')])];
}

export function cursorCliDeny(preset: PresetName): string[] {
  const out = ['Read(.env)', 'Read(.env.*)', 'Read(secrets/**)', 'Write(.ai-guardrules/**)', 'Write(AGENTS.md)', 'Write(.cursor/hooks.json)', 'Shell(ai-guardrules)'];
  if (preset === 'strict') out.push('Shell(rm)', 'Shell(rmdir)', 'Shell(gh)', 'Shell(sudo)');
  return out;
}

export function cursorCliDenyAll(): string[] {
  return [...new Set([...cursorCliDeny('standard'), ...cursorCliDeny('strict')])];
}
