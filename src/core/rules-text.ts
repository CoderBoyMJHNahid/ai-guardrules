export type PresetName = 'strict' | 'standard';

const STRICT = `# AI Rules (enforced)

These rules are enforced by hooks in this project. Ignoring them gets the action blocked, so follow them from the start. When something is blocked, do not retry it or look for a way around it. Stop and ask the user in chat.

1. **Every shell command needs the user's approval.** Reading and editing existing project files is fine. Running any command is not, unless the user already approved it. The only commands that run without a prompt are read-only git commands.
2. **Git is read-only.** You may run \`git status\`, \`log\`, \`diff\`, \`show\`, \`blame\`, \`branch\` (list), \`rev-parse\`, \`ls-files\`, \`ls-tree\`, \`cat-file\`, \`grep\`, \`describe\`, \`shortlog\`, \`rev-list\`, \`merge-base\`, \`show-ref\`, \`remote -v\`, \`tag -l\` and \`config --get\`. Never run \`git add\`, \`commit\`, \`push\`, \`pull\`, \`checkout\`, \`reset\`, \`stash\`, \`rebase\` or any other git command, and never use the \`gh\` CLI.
3. **Never touch the database without permission, and never delete from it.** No \`DROP\`, \`DELETE\`, \`TRUNCATE\`, \`flushall\`, \`migrate reset\` or similar, ever. Any database command or database tool needs the user's explicit approval first.
4. **Never delete files in this project.** No \`rm\`, \`rmdir\`, \`unlink\`, \`find -delete\`, \`Remove-Item\`, \`del\`, or deleting through code or tools. Moving a file over another one counts as deleting it.
5. **Stay inside this project folder.** Do not read, write, list or \`cd\` outside it, and do not follow symlinks out of it. If you need something outside, ask the user.
6. **Do not create files without the user's permission or an approved plan.** Editing an existing file is fine. Creating a new file needs approval first.

Also: never read or print secrets (\`.env\`, private keys, credentials), and never edit the guardrail files (\`.ai-rules/\`, the hook configs, \`AGENTS.md\`, \`CLAUDE.md\`, \`GEMINI.md\`). Only the user changes them, with the \`ai-rules\` command.

Always communicate with the user: say what you want to do and wait for approval.`;

const STANDARD = `# AI Rules (enforced)

These rules are enforced by hooks in this project. When something is blocked, do not retry it or look for a way around it. Stop and ask the user in chat.

1. **Never read or print secrets.** \`.env\` files, private keys, certificates and credential files are off limits.
2. **Never run destructive commands.** That means \`rm -rf\` on the project, home or root, \`git push --force\`, \`git reset --hard\`, \`git clean -fd\`, \`chmod -R 777\`, piping downloads into a shell, disk formatting, shutdown, and any database \`DROP\`, \`DELETE\` or \`TRUNCATE\`.
3. **Never edit the guardrail files** (\`.ai-rules/\`, the hook configs, \`AGENTS.md\`, \`CLAUDE.md\`, \`GEMINI.md\`). Only the user changes them, with the \`ai-rules\` command.`;

export function rulesBody(preset: PresetName | 'custom', custom: string, mode: 'full' | 'pointer'): string {
  const base = preset === 'standard' ? STANDARD : STRICT;
  const extra = custom.trim() ? `\n\n## Project rules\n\n${custom.trim()}` : '';
  if (mode === 'full') return base + extra;
  return `# AI Rules (enforced)

This project uses \`ai-rules\`. The full rules are in \`AGENTS.md\` (between the \`ai-rules\` markers). Read and follow them. Hooks enforce them: blocked actions are not retried, and anything that needs permission is asked in chat first.${
    preset === 'standard'
      ? ' In short: no secrets, no destructive commands, and no editing of guardrail files.'
      : ' In short: every shell command needs approval, git is read-only, no database changes or deletes, no deleting files, stay inside the project, and no new files without approval.'
  }${extra}`;
}
