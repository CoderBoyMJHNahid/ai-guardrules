import type { Dialect } from '../types.js';
import {
  MAX_DEPTH,
  plainWord,
  type EnvAssign,
  type InlineCode,
  type ParseCtx,
  type ParseResult,
  type RawCommand,
  type Redirect,
  type SimpleCommand,
  type Word,
} from './model.js';

export type NestedParser = (script: string, dialect: Dialect, ctx: ParseCtx, res: ParseResult, via: string[]) => void;

export function normName(raw: string): string {
  let n = raw.replace(/\\/g, '/');
  n = n.slice(n.lastIndexOf('/') + 1).toLowerCase();
  n = n.replace(/\.(exe|cmd|bat|com|ps1)$/, '');
  if (/^(python|pypy)[0-9.]*$/.test(n) || n === 'py' || n === 'py3') return 'python';
  if (n === 'nodejs') return 'node';
  return n;
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Frame {
  words: Word[];
  env: EnvAssign[];
  redirects: Redirect[];
  heredocs: string[];
  pipedFrom: SimpleCommand | null;
  src: string;
  via: string[];
  dialect: Dialect;
  stdinArgs: boolean;
}

/** Index of the first positional argument after options. */
function skipOptions(args: Word[], valueOpts: Set<string>, start = 0): number {
  let i = start;
  while (i < args.length) {
    const a = (args[i] as Word).value;
    if (a === '--') return i + 1;
    if (!a.startsWith('-') || a === '-') return i;
    if (valueOpts.has(a)) i += 2;
    else i += 1;
  }
  return i;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'csh', 'tcsh', 'mksh']);
const PKG_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);

function pkgCommandName(spec: string): string {
  let s = spec;
  const slash = s.lastIndexOf('/');
  if (s.startsWith('@') && slash > 0) s = s.slice(slash + 1);
  const at = s.indexOf('@', 1);
  if (at > 0) s = s.slice(0, at);
  return s;
}

function joinWords(words: Word[]): string {
  return words.map((w) => w.raw).join(' ');
}

function extractInline(name: string, args: Word[]): InlineCode[] {
  const out: InlineCode[] = [];
  const val = (i: number): string | undefined => args[i]?.value;
  const flagTakesNext = (re: RegExp, lang: string): void => {
    for (let i = 0; i < args.length; i++) {
      const a = (args[i] as Word).value;
      if (re.test(a) && val(i + 1) !== undefined) {
        out.push({ lang, code: val(i + 1) as string });
        i++;
      }
    }
  };
  switch (name) {
    case 'python':
      for (let i = 0; i < args.length; i++) {
        const a = (args[i] as Word).value;
        if (/^-[A-Za-z]*c$/.test(a) && val(i + 1) !== undefined) {
          out.push({ lang: 'python', code: val(i + 1) as string });
          break;
        }
      }
      break;
    case 'node':
    case 'bun':
      flagTakesNext(/^(-e|--eval|-p|--print|-pe)$/, 'node');
      break;
    case 'deno':
      if (val(0) === 'eval' && val(1) !== undefined) out.push({ lang: 'node', code: args.slice(1).map((w) => w.value).join(' ') });
      break;
    case 'perl':
      flagTakesNext(/^-[A-Za-z]*[eE]$/, 'perl');
      break;
    case 'ruby':
      flagTakesNext(/^-[A-Za-z]*e$/, 'ruby');
      break;
    case 'php':
      flagTakesNext(/^-r$/, 'php');
      break;
    case ':net':
      if (val(0) !== undefined) out.push({ lang: 'powershell', code: val(0) as string });
      break;
    case 'lua':
    case 'osascript':
    case 'rscript':
    case 'julia':
      flagTakesNext(/^-e$/, name);
      break;
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk': {
      for (let i = 0; i < args.length; i++) {
        const a = (args[i] as Word).value;
        if (a === '-f') {
          i++;
          continue;
        }
        if (a === '-v' || a === '-F') {
          i++;
          continue;
        }
        if (a.startsWith('-')) continue;
        out.push({ lang: 'awk', code: a });
        break;
      }
      break;
    }
    default:
  }
  return out;
}

export function finalize(raws: RawCommand[], dialect: Dialect, ctx: ParseCtx, res: ParseResult, nested: NestedParser, via: string[] = []): void {
  const done = new Map<RawCommand, SimpleCommand>();
  for (const raw of raws) {
    const frame: Frame = {
      words: raw.words,
      env: raw.env,
      redirects: raw.redirects,
      heredocs: raw.heredocs,
      pipedFrom: raw.pipedFrom ? (done.get(raw.pipedFrom) ?? null) : null,
      src: raw.src,
      via,
      dialect,
      stdinArgs: false,
    };
    const last = processFrame(frame, ctx, res, nested, 0);
    if (last) done.set(raw, last);
  }
}

function push(frame: Frame, res: ParseResult, name: string, rawName: string, args: Word[]): SimpleCommand {
  const cmd: SimpleCommand = {
    name,
    rawName,
    args,
    env: frame.env,
    redirects: frame.redirects,
    heredocs: frame.heredocs,
    via: frame.via,
    dialect: frame.dialect,
    inline: extractInline(name, args),
    pipedFrom: frame.pipedFrom,
    stdinArgs: frame.stdinArgs,
    src: frame.src,
  };
  res.commands.push(cmd);
  return cmd;
}

function note(res: ParseResult, reason: string, detail: string, severity: 'deny' | 'ask'): void {
  res.unresolved.push({ reason, detail, severity });
}

function processFrame(frame: Frame, ctx: ParseCtx, res: ParseResult, nested: NestedParser, depth: number): SimpleCommand | null {
  if (frame.words.length === 0) {
    // Only assignments or redirects: still record redirects (e.g. "> file").
    if (frame.redirects.length || frame.env.length) return push(frame, res, ':', ':', []);
    return null;
  }
  if (depth > MAX_DEPTH) {
    note(res, 'too-deeply-nested', frame.src, 'deny');
    return null;
  }
  const first = frame.words[0] as Word;
  const args = frame.words.slice(1);
  if (first.dynamic) {
    note(res, 'dynamic-command', first.raw, 'deny');
    return push(frame, res, '', first.raw, args);
  }
  const rawName = first.value;
  const name = normName(rawName);
  const sub = (words: Word[], extra: { via: string; env?: EnvAssign[]; stdinArgs?: boolean }): SimpleCommand | null =>
    processFrame(
      {
        ...frame,
        words,
        via: [...frame.via, extra.via],
        env: extra.env ?? frame.env,
        stdinArgs: extra.stdinArgs ?? frame.stdinArgs,
      },
      ctx,
      res,
      nested,
      depth + 1,
    );
  const subScript = (script: string, dialect: Dialect, via: string): void => {
    nested(script, dialect, { ...ctx, depth: ctx.depth + 1 }, res, [...frame.via, via]);
  };

  switch (name) {
    case 'sudo':
    case 'doas': {
      const valueOpts = new Set(['-u', '-g', '-h', '-p', '-C', '-U', '-r', '-t', '-D', '-R', '-T']);
      const shellMode = args.some((a) => a.value === '-s' || a.value === '-i');
      const i = skipOptions(args, valueOpts);
      const rest = args.slice(i);
      if (rest.length === 0) {
        push(frame, res, name, rawName, args);
        return null;
      }
      if (shellMode && rest.length) {
        subScript(joinWords(rest), 'bash', name);
        return null;
      }
      return sub(rest, { via: name });
    }
    case 'alias': {
      // An alias can rename a harmless-looking word to a dangerous command later in the same line.
      if (args.some((a) => a.value.includes('='))) note(res, 'alias', frame.src, 'deny');
      return push(frame, res, name, rawName, args);
    }
    case 'time':
    case 'command':
    case 'builtin':
    case 'exec':
    case 'nohup':
    case 'setsid':
    case 'unbuffer':
    case 'caffeinate':
    case 'stdbuf':
    case 'nice':
    case 'ionice': {
      if (name === 'command' && args.some((a) => a.value === '-v' || a.value === '-V')) return push(frame, res, name, rawName, args);
      const valueOpts = new Set(['-n', '-c', '-a', '-p', '-o', '-i', '-e']);
      const i = skipOptions(args, name === 'stdbuf' || name === 'nice' || name === 'ionice' ? valueOpts : new Set(name === 'exec' ? ['-a'] : []));
      const rest = args.slice(i);
      if (rest.length === 0) return push(frame, res, name, rawName, args);
      return sub(rest, { via: name });
    }
    case 'env': {
      const env: EnvAssign[] = [...frame.env];
      let i = 0;
      while (i < args.length) {
        const a = (args[i] as Word).value;
        if (a === '--') {
          i++;
          break;
        }
        if (a === '-S' || a === '--split-string') {
          const script = args[i + 1]?.value ?? '';
          subScript(script, 'bash', 'env -S');
          return null;
        }
        if (a === '-u' || a === '-C' || a === '--unset' || a === '--chdir') {
          i += 2;
          continue;
        }
        if (a.startsWith('-') && a !== '-') {
          i++;
          continue;
        }
        if (ASSIGN.test((args[i] as Word).raw)) {
          const eq = (args[i] as Word).raw.indexOf('=');
          env.push({ name: (args[i] as Word).raw.slice(0, eq), value: { ...(args[i] as Word), value: (args[i] as Word).value.slice((args[i] as Word).value.indexOf('=') + 1) } });
          i++;
          continue;
        }
        break;
      }
      const rest = args.slice(i);
      if (rest.length === 0) return push({ ...frame, env }, res, 'env', rawName, []);
      return sub(rest, { via: 'env', env });
    }
    case 'timeout': {
      const valueOpts = new Set(['-s', '-k', '--signal', '--kill-after']);
      let i = skipOptions(args, valueOpts);
      i += 1; // duration
      const rest = args.slice(i);
      if (rest.length === 0) return push(frame, res, name, rawName, args);
      return sub(rest, { via: name });
    }
    case 'watch': {
      const i = skipOptions(args, new Set(['-n', '--interval', '-d', '--differences']));
      const rest = args.slice(i);
      if (rest.length === 0) return push(frame, res, name, rawName, args);
      subScript(joinWords(rest), 'bash', name);
      return null;
    }
    case 'xargs':
    case 'parallel': {
      const valueOpts = new Set(['-I', '-L', '-n', '-P', '-s', '-E', '-d', '-a', '-j', '-N', '-S', '--max-args', '--max-procs', '--delimiter', '--arg-file']);
      const i = skipOptions(args, valueOpts);
      const rest = args.slice(i);
      if (rest.length === 0) return push(frame, res, name, rawName, args);
      const sep = rest.findIndex((w) => w.value === ':::' || w.value === '::::');
      const cmdWords = sep === -1 ? rest : rest.slice(0, sep);
      note(res, 'stdin-arguments', `${name} passes arguments from stdin`, 'ask');
      return sub(cmdWords, { via: name, stdinArgs: true });
    }
    case 'find': {
      const cmd = push(frame, res, name, rawName, args);
      for (let i = 0; i < args.length; i++) {
        const a = (args[i] as Word).value;
        if (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir') {
          let j = i + 1;
          const inner: Word[] = [];
          while (j < args.length && (args[j] as Word).value !== ';' && (args[j] as Word).value !== '+') inner.push(args[j++] as Word);
          if (inner.length) sub(inner, { via: 'find ' + a });
          i = j;
        }
      }
      return cmd;
    }
    case 'npx':
    case 'bunx':
    case 'pnpx':
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      let rest = args;
      let viaName: string = name;
      if (!PKG_RUNNERS.has(name)) {
        const sub0 = (args[0] as Word | undefined)?.value;
        const isRunner = (name === 'npm' && (sub0 === 'exec' || sub0 === 'x')) || ((name === 'pnpm' || name === 'yarn') && (sub0 === 'dlx' || sub0 === 'exec')) || (name === 'bun' && sub0 === 'x');
        if (!isRunner) return push(frame, res, name, rawName, args);
        rest = args.slice(1);
        viaName = `${name} ${sub0}`;
      }
      const i = skipOptions(rest, new Set(['-p', '--package', '--registry', '--cache', '-w', '--workspace', '--prefix', '--userconfig']));
      // `npx -c "script"`: -c only counts before the command; afterwards it belongs to the command.
      const before = rest.slice(0, i);
      const cIdx = before.findIndex((w) => w.value === '-c' || w.value === '--call');
      if (cIdx !== -1 && rest[cIdx + 1]) {
        subScript(rest[cIdx + 1]!.value, 'bash', viaName);
        return null;
      }
      if (i > 0 && (rest[i - 1] as Word).value.match(/^(-c|--call)$/) && rest[i]) {
        subScript(rest[i]!.value, 'bash', viaName);
        return null;
      }
      const cmdWords = rest.slice(i);
      if (cmdWords.length === 0) return push(frame, res, name, rawName, args);
      const pkg = cmdWords[0] as Word;
      const renamed: Word = { ...pkg, value: pkgCommandName(pkg.value), raw: pkgCommandName(pkg.value) };
      return sub([renamed, ...cmdWords.slice(1)], { via: viaName });
    }
    case 'eval': {
      note(res, 'eval', frame.src, 'deny');
      if (args.length) subScript(args.map((a) => a.value).join(' '), 'bash', 'eval');
      return push(frame, res, name, rawName, args);
    }
    case 'source':
    case '.': {
      note(res, 'source', frame.src, 'deny');
      return push(frame, res, name, rawName, args);
    }
    case 'cmd': {
      const idx = args.findIndex((a) => /^\/[ckr]$/i.test(a.value));
      if (idx !== -1 && args[idx + 1]) {
        subScript(args.slice(idx + 1).map((a) => a.value).join(' '), 'cmd', 'cmd /c');
        return null;
      }
      return push(frame, res, name, rawName, args);
    }
    case 'powershell':
    case 'pwsh': {
      for (let i = 0; i < args.length; i++) {
        const a = (args[i] as Word).value.toLowerCase();
        if (a === '-c' || a === '-command' || a === '/c' || a === '/command') {
          const rest = args.slice(i + 1);
          if (rest.length) {
            subScript(rest.map((w) => w.value).join(' '), 'powershell', name);
            return null;
          }
        }
        if (/^-e(nc(odedcommand)?)?$/i.test(a) || a === '-encodedcommand') {
          const b64 = args[i + 1]?.value ?? '';
          try {
            const decoded = Buffer.from(b64, 'base64').toString('utf16le');
            if (!decoded || /[\u0000-\u0008]/.test(decoded)) throw new Error('bad');
            subScript(decoded, 'powershell', name + ' -EncodedCommand');
            return null;
          } catch {
            note(res, 'encoded-command', 'could not decode -EncodedCommand', 'deny');
            return push(frame, res, name, rawName, args);
          }
        }
        if (a === '-file' || a === '-f') {
          note(res, 'script-file', frame.src, 'ask');
          return push(frame, res, name, rawName, args);
        }
      }
      return push(frame, res, name, rawName, args);
    }
    case 'wsl': {
      const sepIdx = args.findIndex((a) => a.value === '--' || a.value === '-e' || a.value === '--exec');
      const rest = sepIdx !== -1 ? args.slice(sepIdx + 1) : args.slice(skipOptions(args, new Set(['-d', '--distribution', '-u', '--user', '--cd'])));
      if (rest.length) return sub(rest, { via: 'wsl' });
      return push(frame, res, name, rawName, args);
    }
    case 'su': {
      const cIdx = args.findIndex((a) => a.value === '-c' || a.value === '--command');
      if (cIdx !== -1 && args[cIdx + 1]) {
        subScript(args[cIdx + 1]!.value, 'bash', 'su -c');
        return null;
      }
      return push(frame, res, name, rawName, args);
    }
    case 'iex':
    case 'invoke-expression': {
      note(res, 'invoke-expression', frame.src, 'deny');
      return push(frame, res, name, rawName, args);
    }
    default:
  }

  if (SHELLS.has(name)) {
    let cScript: string | null = null;
    let scriptFile = false;
    let i = 0;
    for (; i < args.length; i++) {
      const a = (args[i] as Word).value;
      if (a === '--') {
        i++;
        break;
      }
      if (a.startsWith('--')) continue;
      if (a.startsWith('-') && a.length > 1) {
        if (a.slice(1).includes('c')) {
          cScript = args[i + 1]?.value ?? null;
          break;
        }
        if (a === '-o' || a === '-O') i++;
        continue;
      }
      scriptFile = true;
      break;
    }
    if (cScript !== null) {
      subScript(cScript, 'bash', `${name} -c`);
      return null;
    }
    if (scriptFile || i < args.length) {
      note(res, 'script-file', frame.src, 'ask');
    } else if (frame.heredocs.length) {
      // The shell reads its script from a here-document or here-string: analyse that script.
      subScript(frame.heredocs.join('\n'), 'bash', `${name} <<`);
      return null;
    } else if (frame.pipedFrom) {
      note(res, 'pipe-to-shell', frame.src, 'deny');
    } else {
      note(res, 'interactive-shell', frame.src, 'ask');
    }
    return push(frame, res, name, rawName, args);
  }

  return push(frame, res, name, rawName, args);
}

export { plainWord };
