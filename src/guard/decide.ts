import { analyzeGit, type GitAnalysis } from './git.js';
import { expandBraces, matchPathGlob, matchRootGlob, matchWild } from './glob.js';
import {
  CD_CMDS,
  COPY_CMDS,
  CREATE_CMDS,
  DELETE_CMDS,
  DISK_CMDS,
  DOWNLOADERS,
  INTERPRETERS,
  LINK_CMDS,
  MOVE_CMDS,
  OPAQUE_LAUNCHERS,
  POWER_CMDS,
  READ_ENV_CMDS,
  READ_ONLY_CMDS,
  SHELL_NAMES,
  TEXT_CMDS,
  isRecursiveFlag,
} from './names.js';
import { isInside, isNullDevice, normCase, relPosix, resolvePath, stripStreamSuffix, type PathEnv } from './paths.js';
import { HARD_GUARD_NAMES, type GuardName } from './policy.js';
import { hasDbDelete, hasSqlDelete, isDbDeleteSubcommand, readsEnvironment, scanInline } from './scan.js';
import { parseShell, type ParseResult, type SimpleCommand, type Word } from './shell/index.js';
import { PASS, RANK, type Call, type CustomGuard, type Dialect, type Grant, type Policy, type Verdict } from './types.js';

export interface DecideCtx {
  root: string;
  policy: Policy;
  env: PathEnv;
  grants: Grant[];
  customGuards: CustomGuard[];
  now?: number;
}

export interface DecideResult {
  verdict: Verdict;
  candidates: Verdict[];
  usedGrants: Grant[];
  commands: string[];
}

function mk(ctx: DecideCtx, guard: GuardName, message: string, o: Partial<Verdict> = {}): Verdict | null {
  const mode = ctx.policy.guards[guard] ?? 'off';
  if (mode === 'off' || mode === 'allow') return null;
  const hard = HARD_GUARD_NAMES.includes(guard);
  const { grantable, ...rest } = o;
  return { decision: mode, guard, message, grantable: hard ? false : (grantable ?? true), ...rest };
}

const SYSTEM_BIN_POSIX = ['/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/', '/usr/local/bin/', '/opt/homebrew/bin/', '/opt/local/bin/', '/usr/local/sbin/'];

function isSystemBinary(abs: string, env: PathEnv): boolean {
  const p = abs.replace(/\\/g, '/').toLowerCase();
  if (env.platform === 'win32') return /^[a-z]:\/windows\//.test(p) || /^[a-z]:\/program files( \(x86\))?\//.test(p);
  return SYSTEM_BIN_POSIX.some((d) => p.startsWith(d));
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

const SECRET_PROBES = ['.env', '.env.local', '.env.production', '.env.development', '.env.test', '.envrc', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.netrc', '.aws/credentials', 'secrets/key', 'server.pem', 'private.key'];

/** Returns the matching secret pattern, or null. */
export function secretMatch(ctx: DecideCtx, value: string, cwd: string, o: { glob?: boolean; dialect?: Dialect } = {}): string | null {
  const env = ctx.env;
  const ci = env.caseInsensitive;
  const cands = new Set<string>();
  const t = toPosix(env.platform === 'win32' ? stripStreamSuffix(value) : value).replace(/^\.\//, '');
  cands.add(t);
  const res = resolvePath(value, cwd, env);
  if (res.ok) {
    cands.add(isInside(ctx.root, res.abs, env) ? relPosix(ctx.root, res.abs, env) : toPosix(res.abs));
  }
  const allowed = (c: string): boolean => ctx.policy.secrets.allow.some((a) => matchPathGlob(a, c, ci));
  if (o.glob) {
    // A glob token matches a secret only if that secret exists next to it.
    const dir = t.includes('/') ? t.slice(0, t.lastIndexOf('/') + 1) : '';
    const baseGlob = t.slice(dir.length);
    const dotGlobAllowed = baseGlob.startsWith('.') || o.dialect === 'powershell' || o.dialect === 'cmd';
    for (const probe of SECRET_PROBES) {
      const probeBase = probe.includes('/') ? probe.slice(probe.lastIndexOf('/') + 1) : probe;
      if (probeBase.startsWith('.') && !dotGlobAllowed) continue;
      if (!matchPathGlob(t, dir + probe, ci) && !matchPathGlob(baseGlob, probeBase, ci)) continue;
      const abs = env.api.resolve(cwd, dir + probe);
      if (!env.exists(abs)) continue;
      for (const pat of ctx.policy.secrets.paths) {
        if (matchPathGlob(pat, probe, ci) && !allowed(probe)) return pat;
      }
    }
    return null;
  }
  for (const c of cands) {
    if (allowed(c)) return null;
  }
  for (const c of cands) {
    for (const pat of ctx.policy.secrets.paths) {
      if (matchPathGlob(pat, c, ci)) return pat;
    }
  }
  return null;
}

/** Protected patterns are relative to the project root. */
function protectedMatch(ctx: DecideCtx, abs: string): string | null {
  if (!isInside(ctx.root, abs, ctx.env)) return null;
  const rel = relPosix(ctx.root, abs, ctx.env);
  const ci = ctx.env.caseInsensitive;
  for (const pat of ctx.policy.protected) {
    if (matchRootGlob(pat, rel, ci)) return pat;
    if (pat.endsWith('/**') && matchRootGlob(pat.slice(0, -3), rel, ci)) return pat;
  }
  return null;
}

function looksPath(v: string, dialect: Dialect): boolean {
  if (/^(~|\.{1,2}([\\/]|$)|\/|[A-Za-z]:[\\/]|\\\\)/.test(v)) return true;
  if (v.includes('/')) return true;
  if (dialect !== 'bash' && v.includes('\\')) return true;
  return false;
}

function isFlagWord(v: string, dialect: Dialect): boolean {
  if (v.startsWith('-') && v.length > 1) return true;
  if (dialect === 'cmd' && /^\/[A-Za-z?](:.*)?$/.test(v)) return true;
  return false;
}

interface PathArg {
  word: Word;
  value: string;
}

function pathArgs(cmd: SimpleCommand, dialect: Dialect): PathArg[] {
  const out: PathArg[] = [];
  for (const w of cmd.args) {
    let v = w.value;
    if (isFlagWord(v, dialect)) {
      const eq = v.indexOf('=');
      if (eq > 0) v = v.slice(eq + 1);
      else if (dialect === 'powershell' && /^-[A-Za-z]+:/.test(v)) v = v.slice(v.indexOf(':') + 1);
      else continue;
    }
    if (v === '' || v.includes('://') || /^\d+$/.test(v) || v === '{}' || isNullDevice(v)) continue;
    if (/\s/.test(v) && !/^(~|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/])/.test(v)) continue; // free text
    out.push({ word: w, value: v });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shell analysis
// ---------------------------------------------------------------------------

interface ShellOutcome {
  verdicts: Verdict[];
  explicitReadOnly: boolean;
  parse: ParseResult;
}

function nonFlags(cmd: SimpleCommand, dialect: Dialect): Word[] {
  return cmd.args.filter((a) => !isFlagWord(a.value, dialect));
}

function dangerousDeleteTarget(ctx: DecideCtx, v: string, cwd: string): boolean {
  if (['*', '.*', '.', './', '..', '../', '/*', '~/*', '*.*', '.\\', '..\\'].includes(v)) return true;
  const res = resolvePath(v, cwd, ctx.env);
  if (!res.ok) return true;
  const env = ctx.env;
  const abs = normCase(res.abs, env);
  if (abs === normCase(ctx.root, env)) return true;
  if (abs === normCase(env.home, env)) return true;
  if (env.api.parse(res.abs).root === res.abs) return true; // filesystem or drive root
  // an ancestor of the project root
  if (isInside(res.abs, ctx.root, env)) return true;
  return false;
}

function analyzeShell(call: Call, ctx: DecideCtx): ShellOutcome {
  const dialect = call.dialect ?? 'bash';
  const env = ctx.env;
  const command = call.command ?? '';
  const cwdIn = call.cwd || ctx.root;
  const parse = parseShell(command, dialect, { vars: env.vars, cwd: cwdIn, platform: env.platform });
  const verdicts: Verdict[] = [];
  const push = (v: Verdict | null): void => {
    if (v) verdicts.push(v);
  };
  const cmdGrant = { grantKind: 'command' as const };

  const cwdRes = resolvePath(cwdIn, ctx.root, env);
  let eff = cwdRes.ok ? cwdRes.abs : ctx.root;
  if (!cwdRes.ok || !isInside(ctx.root, cwdRes.abs, env)) {
    push(mk(ctx, 'boundary', `The working directory is outside the project folder (${cwdIn}).`, cmdGrant));
  }

  for (const u of parse.unresolved) {
    if (u.severity === 'deny') push(mk(ctx, 'unparseable', `The command cannot be analysed safely (${u.reason}).`, cmdGrant));
  }

  const gitCache = new Map<SimpleCommand, GitAnalysis>();
  const gitOf = (c: SimpleCommand): GitAnalysis => {
    let a = gitCache.get(c);
    if (!a) {
      a = analyzeGit(c, ctx.policy.git.allow);
      gitCache.set(c, a);
    }
    return a;
  };

  if (/:\s*\(\s*\)\s*\{/.test(command)) push(mk(ctx, 'destructive', 'Fork bomb pattern.', { grantable: false }));

  for (const cmd of parse.commands) {
    const name = cmd.name;
    const argv = cmd.args.map((a) => a.value);
    const lower = argv.map((a) => a.toLowerCase());
    const flags = argv.filter((a) => isFlagWord(a, dialect));
    const positional = nonFlags(cmd, dialect);
    const redirectTargets = cmd.redirects.filter((r) => r.target && !isNullDevice(r.target.value)).map((r) => r.target as Word);

    if (name === '') continue;

    // --- self protection ------------------------------------------------
    const gitInfo = name === 'git' ? gitOf(cmd) : null;
    const sedWrite = (name === 'sed' || name === 'awk') && (lower.some((a) => /^-[a-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place=')) || cmd.inline.some((i) => /\bsystem\s*\(/.test(i.code)));
    const readOnlyCmd = (READ_ONLY_CMDS.has(name) || ((name === 'sed' || name === 'awk') && !sedWrite) || (gitInfo?.readOnly ?? false)) && !(name === 'find' && (lower.includes('-delete') || lower.some((a) => a.startsWith('-exec'))));
    if (name === 'ai-guardrules' || (!readOnlyCmd && (argv.some((a) => /(^|[\\/])ai-guardrules([\\/]|$)/i.test(a) && !isFlagWord(a, dialect)) || cmd.inline.some((i) => /\bai-guardrules\b/i.test(i.code))))) {
      push(mk(ctx, 'selfProtection', 'Agents may not run or change ai-guardrules; only the user can change guardrails.', { grantable: false }));
    }
    for (const w of [...cmd.args, ...redirectTargets]) {
      const isRedirect = redirectTargets.includes(w);
      if (!isRedirect && (isFlagWord(w.value, dialect) && !w.value.includes('='))) continue;
      let v = w.value;
      if (isFlagWord(v, dialect) && v.includes('=')) v = v.slice(v.indexOf('=') + 1);
      if (v === '' || w.dynamic || v.includes('://')) continue;
      const res = resolvePath(v, eff, env);
      if (!res.ok) continue;
      const prot = protectedMatch(ctx, res.abs);
      if (prot && (isRedirect || !readOnlyCmd)) {
        push(mk(ctx, 'selfProtection', `${prot} is part of the guardrails and cannot be changed by an agent.`, { grantable: false }));
      }
    }

    // --- cd tracking ----------------------------------------------------
    if (CD_CMDS.has(name)) {
      const target = positional.find((w) => !(dialect === 'cmd' && /^\/d$/i.test(w.value)));
      if (!target || target.value === '-' || target.dynamic) {
        push(mk(ctx, 'boundary', 'Changing to an unknown directory could leave the project folder.', cmdGrant));
      } else {
        const r = resolvePath(target.value, eff, env);
        if (!r.ok || !isInside(ctx.root, r.abs, env)) push(mk(ctx, 'boundary', `cd ${target.value} leaves the project folder.`, { ...cmdGrant, grantPaths: r.ok ? [r.abs] : [] }));
        else eff = r.abs;
      }
    }

    // --- secrets ---------------------------------------------------------
    if (READ_ENV_CMDS.has(name) && (positional.length === 0 || positional.some((w) => /key|token|secret|pass|cred/i.test(w.value)))) {
      push(mk(ctx, 'secrets', `${name} would print environment variables, which may contain secrets.`, { grantable: false }));
    }
    const cmdSetDisplay = name === 'set' && dialect === 'cmd' && argv.length > 0 && !argv.some((a) => a.includes('=')) && !lower.some((a) => a === '/a' || a === '/p');
    if (cmdSetDisplay || (name === 'set' && argv.length === 0 && dialect !== 'powershell') || ((name === 'export' || name === 'declare' || name === 'typeset') && lower.some((a) => a === '-p' || a === '-x')) || (name === 'compgen' && lower.includes('-e'))) {
      push(mk(ctx, 'secrets', 'Listing the environment may reveal secrets.', { grantable: false }));
    }
    if (['get-childitem', 'gci', 'ls', 'dir', 'get-item', 'gi'].includes(name) && lower.some((a) => /^env:/.test(a) || a === '-path:env:' )) {
      push(mk(ctx, 'secrets', 'Listing the environment may reveal secrets.', { grantable: false }));
    }
    for (const w of [...cmd.args, ...redirectTargets]) {
      let v = w.value;
      const isRedirect = redirectTargets.includes(w);
      if (isFlagWord(v, dialect)) {
        if (!v.includes('=')) continue;
        v = v.slice(v.indexOf('=') + 1);
      }
      if (v === '' || v.includes('://')) continue;
      if (!isRedirect && TEXT_CMDS.has(name) && name !== 'echo' && name !== 'printf') continue;
      // {a,b} brace expansion, and the file part of "key=@file" upload syntax (curl -F f=@.env).
      const variants = new Set<string>(dialect === 'bash' ? expandBraces(v) : [v]);
      for (const x of [...variants]) {
        const at = x.indexOf('@');
        if (at >= 0 && at < x.length - 1) variants.add(x.slice(at + 1));
      }
      for (const x of variants) {
        const hit = secretMatch(ctx, x, eff, { glob: w.glob, dialect });
        if (hit) {
          push(mk(ctx, 'secrets', `${x} matches the secret file pattern "${hit}".`, { grantable: false }));
          break;
        }
      }
    }

    // --- boundary ----------------------------------------------------------
    if (ctx.policy.guards.boundary !== 'off') {
      for (const pa of TEXT_CMDS.has(name) ? [] : pathArgs(cmd, dialect)) {
        const v = pa.value;
        if (pa.word.dynamic) {
          if (/^\$\(subst\)/.test(v)) continue;
          if (/^[$%~]/.test(v) || looksPath(v, dialect)) push(mk(ctx, 'boundary', `The path "${pa.word.raw}" cannot be resolved, so it may leave the project.`, cmdGrant));
          continue;
        }
        const pathish = looksPath(v, dialect);
        if (!pathish && !env.exists(env.api.resolve(eff, v))) continue;
        const r = resolvePath(v, eff, env);
        if (!r.ok) {
          push(mk(ctx, 'boundary', r.reason, cmdGrant));
        } else if (!isInside(ctx.root, r.abs, env)) {
          push(mk(ctx, 'boundary', `${v} is outside the project folder.`, { ...cmdGrant, grantPaths: [r.abs] }));
        }
      }
      for (const w of redirectTargets) {
        if (w.dynamic) {
          push(mk(ctx, 'boundary', `The redirect target "${w.raw}" cannot be resolved.`, cmdGrant));
          continue;
        }
        const r = resolvePath(w.value, eff, env);
        if (!r.ok || !isInside(ctx.root, r.abs, env)) push(mk(ctx, 'boundary', `Redirecting output to ${w.value} leaves the project folder.`, { ...cmdGrant, grantPaths: r.ok ? [r.abs] : [] }));
      }
      if (/[\\/]/.test(cmd.rawName) && cmd.via.length === 0) {
        const r = resolvePath(cmd.rawName, eff, env);
        if (!r.ok) push(mk(ctx, 'boundary', r.reason, cmdGrant));
        else if (!isInside(ctx.root, r.abs, env) && !isSystemBinary(r.abs, env)) push(mk(ctx, 'boundary', `${cmd.rawName} is outside the project folder.`, { ...cmdGrant, grantPaths: [r.abs] }));
      }
    }
    for (const w of redirectTargets) {
      if (!w.dynamic && /^\/dev\//.test(toPosix(w.value)) && !/^\/dev\/(stdout|stderr|stdin|tty)$/.test(w.value)) {
        push(mk(ctx, 'destructive', `Writing to device ${w.value}.`, { grantable: false }));
      }
    }

    // --- git ---------------------------------------------------------------
    if (name === 'git' && gitInfo) {
      if (gitInfo.destructive) push(mk(ctx, 'destructive', gitInfo.destructive + '.', { grantable: false }));
      if (!gitInfo.readOnly) push(mk(ctx, 'git', gitInfo.reason || 'Only read-only git commands are allowed.', cmdGrant));
    }
    if (name === 'gh' || name === 'hub') push(mk(ctx, 'git', 'The GitHub CLI is not allowed.', cmdGrant));

    // --- destructive ---------------------------------------------------------
    if (DELETE_CMDS.has(name)) {
      const recursive = flags.some((f) => isRecursiveFlag(f)) || lower.includes('-recurse');
      const targets = positional.map((w) => w.value);
      if (flags.includes('--no-preserve-root') || (recursive && targets.some((t) => dangerousDeleteTarget(ctx, t, eff)))) {
        push(mk(ctx, 'destructive', 'Recursive delete of the project, home or filesystem root.', { grantable: false }));
      }
    }
    if (name === 'chmod' && flags.some((f) => /^(-R|-r|\/s|-recurse)$/i.test(f)) && argv.some((a) => /^(0?777|a\+rwx|ugo\+rwx|a=rwx)$/.test(a))) {
      push(mk(ctx, 'destructive', 'chmod -R 777 makes everything world-writable.', { grantable: false }));
    }
    if (DISK_CMDS.has(name) || /^mkfs\./.test(name)) {
      if (name !== 'diskutil' || lower.some((a) => /^(erase|zero|secure|partition|reformat)/.test(a))) push(mk(ctx, 'destructive', `${name} can destroy disks.`, { grantable: false }));
    }
    if (name === 'dd' && argv.some((a) => /^of=(\/dev\/|\\\\\.\\)/.test(a) && a !== 'of=/dev/null')) {
      push(mk(ctx, 'destructive', 'dd writing to a device.', { grantable: false }));
    }
    if (POWER_CMDS.has(name)) push(mk(ctx, 'destructive', `${name} would shut down or restart the machine.`, { grantable: false }));
    if ((SHELL_NAMES.has(name) || INTERPRETERS.has(name)) && cmd.pipedFrom) {
      let up: SimpleCommand | null = cmd.pipedFrom;
      while (up) {
        if (DOWNLOADERS.has(up.name)) {
          push(mk(ctx, 'destructive', 'Downloading and executing code in one step.', { grantable: false }));
          break;
        }
        up = up.pipedFrom;
      }
    }

    // --- file deletion ---------------------------------------------------------
    let deletes = DELETE_CMDS.has(name);
    if (name === 'find' && (lower.includes('-delete') || lower.includes('-fprint') || lower.includes('-fls'))) deletes = true;
    if (name === 'rsync' && lower.some((a) => a.startsWith('--delete') || a === '--remove-source-files')) deletes = true;
    if (name === 'robocopy' && lower.some((a) => /^\/(mir|purge|mov|move)$/.test(a))) deletes = true;
    if (name === 'dd' && argv.some((a) => a.startsWith('of=') && a !== 'of=/dev/null')) deletes = true;
    if (name === 'git' && gitInfo?.destructive?.includes('git clean')) deletes = true;
    if (name === 'tar' && lower.some((a) => a === '--remove-files')) deletes = true;
    if (name === 'gio' && lower.some((a) => a === 'trash' || a === 'remove')) deletes = true;
    if (name === 'zip' && lower.some((a) => /^-[a-zA-Z]*m[a-zA-Z]*$/.test(a) || a === '--move')) deletes = true;
    if (MOVE_CMDS.has(name) && positional.length >= 2 && isNullDevice((positional[positional.length - 1] as Word).value)) deletes = true;
    if (deletes) push(mk(ctx, 'fileDelete', `${name} deletes files and is not allowed.`, cmdGrant));
    if (MOVE_CMDS.has(name) && positional.length >= 2) {
      const destW = positional[positional.length - 1] as Word;
      const dest = resolvePath(destW.value, eff, env);
      if (dest.ok) {
        const srcs = positional.slice(0, -1);
        const overwrites = env.isFile(dest.abs) || (env.isDir(dest.abs) && srcs.some((s) => env.exists(env.api.join(dest.abs, env.api.basename(s.value)))));
        if (overwrites) push(mk(ctx, 'fileDelete', `${name} would overwrite an existing file.`, cmdGrant));
      }
    }

    // --- symlinks -----------------------------------------------------------------
    if (LINK_CMDS.has(name) || (name === 'fsutil' && lower.some((a) => a === 'hardlink' || a === 'reparsepoint')) || ((name === 'new-item' || name === 'ni') && lower.some((a) => /symboliclink|junction|hardlink/.test(a)))) {
      push(mk(ctx, 'symlinks', 'Creating links could be used to reach files outside the project.', cmdGrant));
    }

    // --- opaque launchers ------------------------------------------------------------
    if (OPAQUE_LAUNCHERS.has(name) || (name === 'wmic' && lower.some((a) => a === 'create' || a === 'call'))) push(mk(ctx, 'unparseable', `${name} launches programs that cannot be analysed.`, cmdGrant));

    // --- database --------------------------------------------------------------------
    const dbCmd = ctx.policy.database.commands.includes(name) || (name === 'rails' || name === 'rake') && lower.some((a) => a.startsWith('db:')) || (name === 'bin/rails');
    const containerCmd = ['docker', 'podman', 'kubectl', 'nerdctl', 'ssh', 'docker-compose', 'oc'].includes(name);
    const containerDb = containerCmd && argv.some((a) => ctx.policy.database.commands.includes(a.toLowerCase().replace(/^.*[\\/]/, '')));
    if (dbCmd || containerDb) {
      const text = [command, ...cmd.heredocs, ...parse.text].join('\n');
      const delSub = dbCmd && lower.some((a) => isDbDeleteSubcommand(a)) || /^(dropdb|dropuser)$/.test(name);
      if (delSub || hasDbDelete(text)) push(mk(ctx, 'databaseDelete', 'Database delete, drop and truncate operations are never allowed.', { grantable: false }));
      push(mk(ctx, 'database', `${name} accesses a database.`, cmdGrant));
    }

    // --- inline interpreter code ----------------------------------------------------------
    for (const inl of cmd.inline) {
      const tags = scanInline(inl.code);
      if (tags.has('sql-delete')) push(mk(ctx, 'databaseDelete', 'Inline code contains a database delete.', { grantable: false }));
      if (tags.has('delete')) push(mk(ctx, 'fileDelete', 'Inline code deletes files.', cmdGrant));
      if (tags.has('subprocess')) push(mk(ctx, 'unparseable', 'Inline code starts other programs, which cannot be analysed.', cmdGrant));
      if (tags.has('git')) push(mk(ctx, 'git', 'Inline code runs git commands.', cmdGrant));
      if (tags.has('parent-path')) push(mk(ctx, 'boundary', 'Inline code refers to parent directories.', cmdGrant));
      if (tags.has('db')) push(mk(ctx, 'database', 'Inline code connects to a database.', cmdGrant));
      if (readsEnvironment(inl.code)) {
        push(mk(ctx, 'secrets', 'Inline code reads the environment, which may contain secrets.', { grantable: false }));
      }
      push(mk(ctx, 'interpreters', 'Inline interpreter code needs approval.', cmdGrant));
    }

    // --- new files ------------------------------------------------------------------------
    const creates: Word[] = [];
    if (CREATE_CMDS.has(name)) {
      let skipNext = false;
      for (const w of cmd.args) {
        if (skipNext) {
          skipNext = false;
          continue;
        }
        const v = w.value.toLowerCase();
        if (isFlagWord(w.value, dialect)) {
          if (/^-(itemtype|type|value|encoding|inputobject|name)$/.test(v)) skipNext = true;
          continue;
        }
        creates.push(w);
      }
      if ((name === 'ni' || name === 'new-item') && !lower.some((a) => /^-(path|name)/.test(a)) && creates.length > 1) creates.splice(1);
    }
    if ((COPY_CMDS.has(name) || MOVE_CMDS.has(name)) && positional.length >= 2) creates.push(positional[positional.length - 1] as Word);
    creates.push(...redirectTargets.filter((w) => !isNullDevice(w.value)));
    if (creates.length && ctx.policy.guards.newFiles !== 'off') {
      const fresh: string[] = [];
      for (const w of creates) {
        if (w.dynamic) {
          fresh.push(w.raw);
          continue;
        }
        const r = resolvePath(w.value, eff, env);
        if (r.ok && !env.exists(r.abs)) fresh.push(r.abs);
      }
      if (fresh.length) push(mk(ctx, 'newFiles', `Creating ${fresh.length === 1 ? 'a new file' : 'new files'} needs your approval (${fresh.map((f) => toPosix(f).split('/').slice(-2).join('/')).join(', ')}).`, { grantKind: 'create', grantPaths: fresh }));
    }
  }

  // --- explicit allow for read-only git ----------------------------------------------------
  const gitOn = ctx.policy.guards.git === 'ask' || ctx.policy.guards.git === 'deny';
  const explicitReadOnly =
    gitOn &&
    parse.commands.length > 0 &&
    parse.unresolved.length === 0 &&
    parse.commands.every((c) => c.name === 'git' && gitOf(c).readOnly && c.redirects.length === 0 && c.inline.length === 0 && !c.pipedFrom);

  if (!explicitReadOnly) push(mk(ctx, 'commands', 'Every shell command needs your approval.', cmdGrant));

  // SQL text that slipped through unrecognised wrappers (heredocs, strings) with a DB client elsewhere is handled above.
  void hasSqlDelete;
  return { verdicts, explicitReadOnly, parse };
}

// ---------------------------------------------------------------------------
// File-tool analysis
// ---------------------------------------------------------------------------

function analyzePathCall(call: Call, ctx: DecideCtx): Verdict[] {
  const out: Verdict[] = [];
  const push = (v: Verdict | null): void => {
    if (v) out.push(v);
  };
  const env = ctx.env;
  const cwd = call.cwd || ctx.root;
  const targetLabel = `${call.toolName}`;
  const paths = call.paths && call.paths.length ? call.paths : call.kind === 'search' ? [cwd] : [];
  for (const p of paths) {
    const r = resolvePath(p, cwd, env);
    if (!r.ok) {
      push(mk(ctx, 'boundary', r.reason, { grantKind: 'path', grantPaths: [] }));
      continue;
    }
    if (!isInside(ctx.root, r.abs, env)) {
      push(mk(ctx, 'boundary', `${p} is outside the project folder.`, { grantKind: 'path', grantPaths: [r.abs] }));
    }
    const hit = secretMatch(ctx, p, cwd);
    if (hit) push(mk(ctx, 'secrets', `${p} matches the secret file pattern "${hit}".`, { grantable: false }));
    if (call.kind === 'write' || call.kind === 'edit' || call.kind === 'delete') {
      const prot = protectedMatch(ctx, r.abs);
      if (prot) push(mk(ctx, 'selfProtection', `${prot} is part of the guardrails and cannot be changed by an agent.`, { grantable: false }));
    }
    if (call.kind === 'delete') push(mk(ctx, 'fileDelete', `${targetLabel} deletes ${p}.`, { grantKind: 'path', grantPaths: [r.abs] }));
    if (call.kind === 'write' && !env.exists(r.abs)) {
      push(mk(ctx, 'newFiles', `Creating ${p} needs your approval.`, { grantKind: 'create', grantPaths: [r.abs] }));
    }
  }
  for (const pat of call.patterns ?? []) {
    if (!pat) continue;
    const hit = secretMatch(ctx, pat, cwd, { glob: true }) ?? probeText(ctx, pat);
    if (hit) push(mk(ctx, 'secrets', `The search pattern "${pat}" would match secret files.`, { grantable: false }));
    if (/(^|[\\/])\.\.([\\/]|$)/.test(pat)) push(mk(ctx, 'boundary', `The pattern "${pat}" refers to a parent directory.`, { grantKind: 'path', grantPaths: [] }));
  }
  return out;
}

function probeText(ctx: DecideCtx, pat: string): string | null {
  const p = toPosix(pat);
  for (const sp of ctx.policy.secrets.paths) {
    if (!/[*?]/.test(sp) && p.toLowerCase().includes(sp.toLowerCase())) return sp;
  }
  if (/(^|\/)\.env(\.[^/]*)?$/.test(p) && !ctx.policy.secrets.allow.some((a) => p.endsWith(a))) return '.env';
  return null;
}

function analyzeMcp(call: Call, ctx: DecideCtx): Verdict[] {
  const out: Verdict[] = [];
  const push = (v: Verdict | null): void => {
    if (v) out.push(v);
  };
  const m = call.mcp ?? { server: '', tool: call.toolName, input: '' };
  const label = `mcp:${m.server}:${m.tool}`;
  const hay = `${m.server} ${m.tool}`.toLowerCase();
  const dbTool = ctx.policy.database.mcpPatterns.some((p) => hay.includes(p.toLowerCase()));
  if (dbTool) {
    if (hasSqlDelete(m.input) || /\b(dropDatabase|dropCollection|deleteMany|deleteOne|flushall|flushdb)\b/i.test(m.input) || /(^|[_\-:])(drop|truncate|delete|destroy|wipe|reset)([_\-:]|$)/i.test(m.tool)) {
      push(mk(ctx, 'databaseDelete', 'Database delete, drop and truncate operations are never allowed.', { grantable: false }));
    }
    push(mk(ctx, 'database', `${label} accesses a database.`, { grantKind: 'command' }));
  }
  push(mk(ctx, 'unknownTools', `MCP tool ${label} needs your approval.`, { grantKind: 'command' }));
  return out;
}

// ---------------------------------------------------------------------------
// Custom guards
// ---------------------------------------------------------------------------

function customVerdicts(call: Call, parse: ParseResult | null, ctx: DecideCtx): Verdict[] {
  const out: Verdict[] = [];
  for (const g of ctx.customGuards) {
    if (g.decision === 'off') continue;
    const kindOk = g.on === 'any' || g.on === call.kind || (g.on === 'write' && call.kind === 'delete') || (g.on === 'read' && call.kind === 'search');
    if (!kindOk) continue;
    let hit = false;
    if (call.kind === 'shell' && parse) {
      for (const c of parse.commands) {
        const args = c.args.map((a) => a.value).join(' ');
        const nameOk = !g.command || matchWild(g.command.toLowerCase(), c.name);
        const matchOk = !g.match || matchWild(g.match, g.command ? args : (call.command ?? ''));
        let pathOk = true;
        if (g.path) {
          pathOk = c.args.some((a) => {
            const r = resolvePath(a.value, call.cwd || ctx.root, ctx.env);
            return r.ok && matchPathGlob(g.path as string, isInside(ctx.root, r.abs, ctx.env) ? relPosix(ctx.root, r.abs, ctx.env) : toPosix(r.abs), ctx.env.caseInsensitive);
          });
        }
        if (nameOk && matchOk && pathOk && (g.command || g.match || g.path)) hit = true;
      }
    } else if (call.kind === 'mcp') {
      const label = `${call.mcp?.server ?? ''}:${call.mcp?.tool ?? call.toolName}`;
      hit = (!g.command || matchWild(g.command, call.mcp?.tool ?? call.toolName) || matchWild(g.command, label)) && (!g.match || matchWild(g.match, call.mcp?.input ?? '')) && Boolean(g.command || g.match);
    } else if (call.paths && g.path) {
      hit = call.paths.some((p) => {
        const r = resolvePath(p, call.cwd || ctx.root, ctx.env);
        return r.ok && matchPathGlob(g.path as string, isInside(ctx.root, r.abs, ctx.env) ? relPosix(ctx.root, r.abs, ctx.env) : toPosix(r.abs), ctx.env.caseInsensitive);
      });
    }
    if (!hit) continue;
    out.push({
      decision: g.decision === 'allow' ? 'allow' : g.decision,
      guard: `custom:${g.id}`,
      message: g.message,
      explicit: g.decision === 'allow',
      grantable: g.decision !== 'allow',
      grantKind: call.kind === 'shell' ? 'command' : 'path',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

function normalizeCmd(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function callTarget(call: Call): string {
  if (call.kind === 'shell') return normalizeCmd(call.command ?? '');
  if (call.kind === 'mcp') return `mcp:${call.mcp?.server ?? ''}:${call.mcp?.tool ?? call.toolName}`;
  if (call.kind === 'other') return `tool:${call.toolName}`;
  return `${call.toolName}:${(call.paths ?? [])[0] ?? ''}`;
}

function grantCovers(g: Grant, v: Verdict, call: Call, ctx: DecideCtx): boolean {
  if (!v.grantable) return false;
  const ci = ctx.env.caseInsensitive;
  const pathsMatch = (pattern: string): boolean => {
    const ps = v.grantPaths ?? [];
    if (ps.length === 0) return false;
    return ps.every((abs) => {
      const rel = isInside(ctx.root, abs, ctx.env) ? relPosix(ctx.root, abs, ctx.env) : toPosix(abs);
      return matchPathGlob(pattern, rel, ci) || matchPathGlob(pattern, toPosix(abs), ci);
    });
  };
  switch (g.kind) {
    case 'command': {
      const target = callTarget(call);
      const pattern = normalizeCmd(g.pattern);
      // A wildcard grant must never smuggle extra commands: chained or piped input only
      // matches a grant that spells out that exact text.
      if (call.kind === 'shell' && pattern !== target && /[;&|`<>\n]|\$\(/.test(target)) return false;
      return matchWild(pattern, target);
    }
    case 'path':
      return pathsMatch(g.pattern);
    case 'create':
      return v.guard === 'newFiles' && pathsMatch(g.pattern);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function decide(call: Call, ctx: DecideCtx): DecideResult {
  let candidates: Verdict[] = [];
  let parse: ParseResult | null = null;
  let explicitReadOnly = false;
  switch (call.kind) {
    case 'shell': {
      const r = analyzeShell(call, ctx);
      candidates = r.verdicts;
      parse = r.parse;
      explicitReadOnly = r.explicitReadOnly;
      break;
    }
    case 'read':
    case 'write':
    case 'edit':
    case 'delete':
    case 'search':
      candidates = analyzePathCall(call, ctx);
      break;
    case 'mcp':
      candidates = analyzeMcp(call, ctx);
      break;
    default: {
      const safe = ctx.policy.safeTools.some((t) => t.toLowerCase() === call.toolName.toLowerCase());
      if (!safe) {
        const v = mk(ctx, 'unknownTools', `Tool ${call.toolName} needs your approval.`, { grantKind: 'command' });
        if (v) candidates.push(v);
      }
    }
  }

  const custom = customVerdicts(call, parse, ctx);
  const customRestrict = custom.filter((v) => v.decision !== 'allow');
  const customAllow = custom.filter((v) => v.decision === 'allow');
  candidates.push(...customRestrict);
  // A custom allow may relax a preset "ask" (never a deny, never a hard guard).
  if (customAllow.length) {
    candidates = candidates.filter((c) => !(c.decision === 'ask' && !c.guard.startsWith('custom:') && !HARD_GUARD_NAMES.includes(c.guard as GuardName)));
  }

  const restrictive = candidates.filter((c) => c.decision !== 'allow');
  const usedGrants: Grant[] = [];
  const now = ctx.now ?? Date.now();
  const live = ctx.grants.filter((g) => g.expiresAt === null || g.expiresAt > now);

  let verdict: Verdict;
  if (restrictive.length === 0) {
    if (explicitReadOnly) verdict = { decision: 'allow', guard: 'git', message: 'read-only git command', explicit: true };
    else if (customAllow.length) verdict = { ...(customAllow[0] as Verdict), explicit: true };
    else verdict = PASS;
  } else {
    const uncovered = restrictive.filter((v) => {
      const g = live.find((gr) => grantCovers(gr, v, call, ctx));
      if (g && !usedGrants.includes(g)) usedGrants.push(g);
      return !g;
    });
    if (uncovered.length === 0) {
      verdict = { decision: 'allow', guard: 'grant', message: 'allowed by a user grant', explicit: true };
    } else {
      usedGrants.length = 0;
      const top = uncovered.reduce((a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a));
      const same = uncovered.filter((v) => v.decision === top.decision);
      const messages = [...new Set(same.map((v) => v.message))];
      verdict = { ...top, message: messages.join(' '), grantable: same.every((v) => v.grantable) };
    }
  }
  return {
    verdict,
    candidates: restrictive,
    usedGrants: verdict.guard === 'grant' ? usedGrants.filter((g) => g.once) : [],
    commands: parse ? parse.commands.map((c) => [c.name, ...c.args.map((a) => a.value)].join(' ')) : [],
  };
}
