import type { Mode, Policy } from './types.js';

export const GUARD_NAMES = [
  'commands',
  'git',
  'database',
  'databaseDelete',
  'fileDelete',
  'boundary',
  'newFiles',
  'secrets',
  'destructive',
  'selfProtection',
  'unparseable',
  'symlinks',
  'interpreters',
  'unknownTools',
] as const;
export type GuardName = (typeof GUARD_NAMES)[number];

/** Guards that can never be relaxed through `policy set`, grants or custom allow rules. */
export const HARD_GUARD_NAMES: GuardName[] = ['databaseDelete', 'secrets', 'selfProtection', 'destructive'];

export const GUARD_DESCRIPTIONS: Record<GuardName, string> = {
  commands: 'Every shell command needs approval',
  git: 'Git is read-only (allowlist), gh is blocked',
  database: 'Database access needs approval',
  databaseDelete: 'Database delete, drop and truncate are blocked',
  fileDelete: 'File deletion is blocked',
  boundary: 'Paths outside the project folder are blocked',
  newFiles: 'Creating new files needs approval',
  secrets: 'Secret files are never read or edited',
  destructive: 'Destructive commands (rm -rf /, force push, ...) are blocked',
  selfProtection: 'Guard files and agent configs are protected',
  unparseable: 'Commands that cannot be analysed are blocked',
  symlinks: 'Creating links is blocked',
  interpreters: 'Inline interpreter code needs approval',
  unknownTools: 'Unknown tools and MCP calls need approval',
};

const SECRET_PATHS = [
  '.env',
  '.env.*',
  '.envrc',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_dsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.aws/credentials',
  '.netrc',
  'secrets/**',
];
const SECRET_ALLOW = ['.env.example', '.env.sample', '.env.template', '.env.dist'];

const GIT_ALLOW = [
  'status',
  'log',
  'diff',
  'show',
  'blame',
  'branch',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'grep',
  'describe',
  'shortlog',
  'rev-list',
  'merge-base',
  'show-ref',
  'remote',
  'tag',
  'config',
  'check-ignore',
];

const DB_COMMANDS = [
  'psql',
  'pgcli',
  'pg_dump',
  'pg_dumpall',
  'pg_restore',
  'createdb',
  'dropdb',
  'createuser',
  'dropuser',
  'mysql',
  'mysqldump',
  'mysqladmin',
  'mycli',
  'mariadb',
  'mongosh',
  'mongo',
  'mongodump',
  'mongorestore',
  'redis-cli',
  'sqlite3',
  'sqlcmd',
  'invoke-sqlcmd',
  'sqlplus',
  'cqlsh',
  'clickhouse-client',
  'cockroach',
  'influx',
  'prisma',
  'knex',
  'sequelize',
  'sequelize-cli',
  'drizzle-kit',
  'typeorm',
  'alembic',
  'flyway',
  'liquibase',
  'supabase',
  'atlas',
  'dbmate',
  'goose',
  'migrate',
];

const DB_MCP = ['sql', 'query', 'database', 'postgres', 'mysql', 'mongo', 'supabase', 'neon', 'prisma', 'redis', 'sqlite', 'dynamo', 'firestore', 'bigquery', 'snowflake', 'planetscale', 'turso'];

export const PROTECTED_PATHS = [
  '.ai-rules/**',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.cursor/hooks.json',
  '.cursor/cli.json',
  '.cursor/rules/ai-rules.mdc',
  '.gemini/settings.json',
  '.windsurf/hooks.json',
  '.windsurf/rules/ai-rules.md',
  '.devin/hooks.json',
  '.codex/hooks.json',
  '.codex/config.toml',
  '.clinerules/ai-rules.md',
  '.github/copilot-instructions.md',
  'CLAUDE.md',
  'GEMINI.md',
  'AGENTS.md',
];

const SAFE_TOOLS = [
  // Claude Code
  'TodoWrite',
  'AskUserQuestion',
  'ExitPlanMode',
  'EnterPlanMode',
  'WebSearch',
  'WebFetch',
  'Agent',
  'Task',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskStop',
  'TaskOutput',
  'BashOutput',
  'KillShell',
  'KillBash',
  'Skill',
  'SlashCommand',
  'ToolSearch',
  'SubagentHandback',
  // Cursor
  'AwaitShell',
  'CreateGoal',
  'UpdateGoal',
  'GenerateImage',
  'ReadLints',
  'SwitchMode',
  'FetchMcpResource',
  // Gemini
  'write_todos',
  'save_memory',
  'google_web_search',
  'web_fetch',
  'activate_skill',
  'ask_user',
  'enter_plan_mode',
  'exit_plan_mode',
];

function base(): Omit<Policy, 'preset' | 'guards'> {
  return {
    version: 1,
    secrets: { paths: [...SECRET_PATHS], allow: [...SECRET_ALLOW] },
    git: { allow: [...GIT_ALLOW] },
    database: { commands: [...DB_COMMANDS], mcpPatterns: [...DB_MCP] },
    protected: [...PROTECTED_PATHS],
    safeTools: [...SAFE_TOOLS],
  };
}

export function standardPolicy(): Policy {
  return {
    preset: 'standard',
    ...base(),
    guards: {
      commands: 'off',
      git: 'off',
      database: 'off',
      databaseDelete: 'deny',
      fileDelete: 'off',
      boundary: 'off',
      newFiles: 'off',
      secrets: 'deny',
      destructive: 'deny',
      selfProtection: 'deny',
      unparseable: 'off',
      symlinks: 'off',
      interpreters: 'off',
      unknownTools: 'off',
    },
  };
}

export function strictPolicy(): Policy {
  return {
    preset: 'strict',
    ...base(),
    guards: {
      commands: 'ask',
      git: 'deny',
      database: 'ask',
      databaseDelete: 'deny',
      fileDelete: 'deny',
      boundary: 'deny',
      newFiles: 'ask',
      secrets: 'deny',
      destructive: 'deny',
      selfProtection: 'deny',
      unparseable: 'deny',
      symlinks: 'deny',
      interpreters: 'ask',
      unknownTools: 'ask',
    },
  };
}

export function presetPolicy(name: 'strict' | 'standard'): Policy {
  return name === 'strict' ? strictPolicy() : standardPolicy();
}

const MODES: Mode[] = ['allow', 'ask', 'deny', 'off'];

function strArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`policy.${field} must be an array of strings`);
  return v as string[];
}

/** Validate untrusted JSON. Throws with a readable message. */
export function validatePolicy(input: unknown): Policy {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('policy must be an object');
  const o = input as Record<string, unknown>;
  if (o.version !== 1) throw new Error('policy.version must be 1');
  const guards = o.guards;
  if (typeof guards !== 'object' || guards === null) throw new Error('policy.guards must be an object');
  const outGuards: Record<string, Mode> = {};
  for (const name of GUARD_NAMES) {
    const m = (guards as Record<string, unknown>)[name];
    if (m === undefined) throw new Error(`policy.guards.${name} is missing`);
    if (typeof m !== 'string' || !MODES.includes(m as Mode)) throw new Error(`policy.guards.${name} must be one of ${MODES.join(', ')}`);
    outGuards[name] = m as Mode;
  }
  const secrets = o.secrets as Record<string, unknown> | undefined;
  const git = o.git as Record<string, unknown> | undefined;
  const database = o.database as Record<string, unknown> | undefined;
  if (!secrets || !git || !database) throw new Error('policy.secrets, policy.git and policy.database are required');
  const preset = o.preset === 'strict' || o.preset === 'standard' || o.preset === 'custom' ? o.preset : 'custom';
  return {
    version: 1,
    preset,
    guards: outGuards,
    secrets: { paths: strArray(secrets.paths, 'secrets.paths'), allow: strArray(secrets.allow, 'secrets.allow') },
    git: { allow: strArray(git.allow, 'git.allow') },
    database: { commands: strArray(database.commands, 'database.commands'), mcpPatterns: strArray(database.mcpPatterns, 'database.mcpPatterns') },
    protected: strArray(o.protected, 'protected'),
    safeTools: strArray(o.safeTools, 'safeTools'),
  };
}
