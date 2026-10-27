/** Text scanners: SQL deletes and inline interpreter code. */

export function stripSqlNoise(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, (m) => (/^#\s*\w+\s*$/.test(m) ? m : ' '))
    .replace(/\s+/g, ' ');
}

const SQL_DELETE_RE =
  /\b(drop\s+(table|database|schema|view|index|column|trigger|function|procedure|user|role|sequence|type|extension|materialized|collection)\b|truncate(\s+table)?\s+[\w"`[]|delete\s+from\b|alter\s+table\s+\S+\s+drop\b)/i;
const NOSQL_DELETE_RE = /\b(dropDatabase|dropCollection|deleteMany|deleteOne|findOneAndDelete|flushall|flushdb)\b/i;
const REDIS_DEL_RE = /(^|\s)(del|unlink)\s+\S/i;

/**
 * Scan a text for delete-like database operations. Two views are checked so that line comments can
 * neither hide a statement (DROP -- x TABLE) nor swallow it (psql --command "DROP TABLE x").
 */
export function hasSqlDelete(text: string): boolean {
  const blockOnly = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ');
  const stripped = stripSqlNoise(text);
  return [blockOnly, stripped].some((t) => SQL_DELETE_RE.test(t) || NOSQL_DELETE_RE.test(t));
}

/** Looser scan used only when we already know a database client is involved. */
export function hasDbDelete(text: string): boolean {
  return hasSqlDelete(text) || REDIS_DEL_RE.test(text);
}

const DELETE_WORD = /(^|[:\-_ ])(reset|drop|rollback|undo|down|destroy|wipe|fresh|flush|purge|truncate)($|[:\-_ ])/i;
export function isDbDeleteSubcommand(token: string): boolean {
  return DELETE_WORD.test(token);
}

/**
 * True when inline code dumps the whole environment or reads a variable that looks like a secret.
 * Reading one harmless variable (process.env.NODE_ENV) is fine.
 */
export function readsEnvironment(code: string): boolean {
  if (/GetEnvironmentVariables\s*\(\s*\)/i.test(code)) return true;
  if (/process\.env(?![.\[\w$])/.test(code)) return true;
  if (/os\.environ(?!\s*(\[|\.get\b))/.test(code) && /os\.environ/.test(code)) return true;
  if (/\bENV\.(to_h|to_a|each|keys|values|inspect)\b|\bENV\s*\)/.test(code)) return true;
  if (/\$_ENV(?!\s*\[)|\$_SERVER(?!\s*\[)|\bgetenv\s*\(\s*\)/.test(code)) return true;
  if (/System\.getenv\s*\(\s*\)/.test(code)) return true;
  if (/(GetEnvironmentVariable|\benviron\b|process\.env|os\.getenv|ENV\[|getenv|\$env:)/i.test(code) && /(key|token|secret|passw|credential|private)/i.test(code)) return true;
  return false;
}

export type InlineTag = 'delete' | 'subprocess' | 'git' | 'parent-path' | 'sql-delete' | 'db';

const DELETE_RE =
  /(\brm(Sync)?\s*\(|\brmdir(Sync)?\b|\bunlink(Sync)?\b|\brimraf\b|\bos\.(remove|unlink|rmdir|removedirs)\b|\bshutil\.rmtree\b|\brmtree\b|FileUtils\.(rm|remove|rm_rf|rm_r|rm_f)|File\.delete|Dir\.rmdir|Remove-Item|\[IO\.(File|Directory)\]::Delete|\[System\.IO\.(File|Directory)\]::Delete|\bDeleteFile\b|\.Delete\s*\(|\bDeno\.remove(Sync)?\b|\.(removeSync|emptyDirSync|emptyDir)\s*\(|\bos\.RemoveAll\b|\bfs\.remove\s*\()/i;
const SUBPROCESS_RE =
  /(child_process|\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*)\b|\bexecSync\b|\bspawnSync\b|\bexecFile\b|\bspawn\s*\(|\bexec\s*\(|\bsystem\s*\(|\bpopen\b|Runtime\.getRuntime|\bOpen3\b|pty\.spawn|Process\.Start|Start-Process|Invoke-Expression|\biex\b|\beval\s*\(|Kernel\.system|\bpassthru\b|\bshell_exec\b|\|\s*getline)/i;
const GIT_RE = /\bgit\s+(push|commit|add|reset|checkout|clean|rebase|merge|pull|fetch|stash|rm|mv|tag|branch|restore|switch|cherry-pick|revert)\b/i;
const DB_DRIVER_RE =
  /(\bpsycopg2?\b|\bpymysql\b|mysql\.connector|\bsqlite3\b|\bpymongo\b|\bredis\.|\bsqlalchemy\b|\basyncpg\b|require\(\s*['"](pg|mysql2?|mongodb|mongoose|sqlite3|better-sqlite3|redis|ioredis|@prisma\/client|knex|sequelize|typeorm)['"]\s*\)|from\s+['"](pg|mysql2?|mongodb|mongoose|sqlite3|better-sqlite3|redis|ioredis|@prisma\/client|knex|sequelize|typeorm)['"]|\bPrismaClient\b|\bDriverManager\b)/i;

export function scanInline(code: string): Set<InlineTag> {
  const tags = new Set<InlineTag>();
  if (DELETE_RE.test(code)) tags.add('delete');
  if (SUBPROCESS_RE.test(code)) tags.add('subprocess');
  if (GIT_RE.test(code)) tags.add('git');
  if (/\.\.[\\/]/.test(code)) tags.add('parent-path');
  if (hasSqlDelete(code)) tags.add('sql-delete');
  if (DB_DRIVER_RE.test(code)) tags.add('db');
  return tags;
}
