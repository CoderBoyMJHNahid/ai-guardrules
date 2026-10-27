import type { RawParse } from './bash.js';
import type { ParseCtx, RawCommand, Redirect, Word } from './model.js';

const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\r';

class CmdError extends Error {}

export function parseCmdRaw(src: string, ctx: ParseCtx): RawParse {
  const out: RawParse = { raws: [], unresolved: [], text: [] };
  try {
    new CmdParser(src, ctx, out).parseList(false);
  } catch (e) {
    if (e instanceof CmdError) out.unresolved.push({ reason: 'parse-error', detail: e.message, severity: 'deny' });
    else throw e;
  }
  return out;
}

class CmdParser {
  i = 0;
  private last: RawCommand | null = null;

  constructor(
    private s: string,
    private ctx: ParseCtx,
    private out: RawParse,
  ) {}

  parseList(inGroup: boolean): void {
    const s = this.s;
    let cur: RawCommand | null = null;
    let pipeFrom: RawCommand | null = null;
    let cmdStart = this.i;
    const newCmd = (): RawCommand => {
      cmdStart = this.i;
      return { words: [], env: [], redirects: [], heredocs: [], pipedFrom: pipeFrom, src: '' };
    };
    const flush = (): void => {
      if (cur && (cur.words.length || cur.redirects.length)) {
        cur.src = s.slice(cmdStart, this.i).trim();
        this.out.raws.push(cur);
        this.last = cur;
      }
      cur = null;
    };

    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (isWs(c)) {
        this.i++;
        continue;
      }
      if (c === '\n') {
        flush();
        pipeFrom = null;
        this.i++;
        continue;
      }
      if (c === '&') {
        flush();
        pipeFrom = null;
        this.i += s[this.i + 1] === '&' ? 2 : 1;
        continue;
      }
      if (c === '|') {
        flush();
        if (s[this.i + 1] === '|') {
          pipeFrom = null;
          this.i += 2;
        } else {
          pipeFrom = this.last;
          this.i++;
        }
        continue;
      }
      if (c === '(' && (cur === null || cur.words.length === 0)) {
        this.i++;
        this.parseList(true);
        continue;
      }
      if (c === ')') {
        this.i++;
        flush();
        if (inGroup) return;
        continue;
      }
      if (cur === null) cur = newCmd();
      const m = /^(\d)?(>>|>|<)(&\d)?/.exec(s.slice(this.i, this.i + 5));
      if (m) {
        this.i += m[0].length;
        if (m[3]) continue;
        while (isWs(s[this.i] ?? '')) this.i++;
        const target = this.readWord();
        if (target) cur.redirects.push({ op: m[0], target } as Redirect);
        continue;
      }
      const word = this.readWord();
      if (!word) {
        this.i++;
        continue;
      }
      if (cur.words.length === 0) {
        let lower = word.value.toLowerCase();
        if (lower.startsWith('@')) {
          word.value = word.value.slice(1);
          word.raw = word.raw.slice(1);
          lower = lower.slice(1);
        }
        if (lower === 'rem' || lower === '::') {
          while (this.i < s.length && s[this.i] !== '\n') this.i++;
          cur = null;
          continue;
        }
        if (lower === 'else') continue;
        if (lower === 'if') {
          this.out.unresolved.push({ reason: 'cmd-control-flow', detail: 'if', severity: 'ask' });
          this.skipIfCondition();
          continue;
        }
        if (lower === 'for') {
          this.out.unresolved.push({ reason: 'cmd-control-flow', detail: 'for', severity: 'ask' });
          // for [/switches] %v in (set) do command
          let w: Word | null;
          while ((w = this.readWordSkipWs()) !== null) {
            if (w.value.toLowerCase() === 'in' && !w.quoted) break;
          }
          while (isWs(s[this.i] ?? '')) this.i++;
          if (s[this.i] === '(') {
            let depth = 0;
            let q = false;
            do {
              const ch = s[this.i] as string;
              if (ch === '"') q = !q;
              else if (!q && ch === '(') depth++;
              else if (!q && ch === ')') depth--;
              this.i++;
            } while (this.i < s.length && depth > 0);
          }
          this.readWordSkipWs(); // "do"
          continue;
        }
        if (lower === 'call') continue;
        if (lower === 'start') {
          // start ["title"] [/switches] command
          for (;;) {
            const save = this.i;
            const w = this.readWordSkipWs();
            if (w === null) break;
            if (w.quoted && w.raw.startsWith('"') && cur.words.length === 0) continue; // window title
            if (w.value.startsWith('/') && !/[\\/].*[\\/]/.test(w.value) && w.value.length <= 10) continue;
            this.i = save;
            break;
          }
          continue;
        }
      }
      cur.words.push(word);
    }
    flush();
    if (inGroup) throw new CmdError('unterminated ( ... )');
  }

  private skipIfCondition(): void {
    let w = this.readWordSkipWs();
    if (w && w.value.toLowerCase() === '/i') w = this.readWordSkipWs();
    if (w && w.value.toLowerCase() === 'not') w = this.readWordSkipWs();
    if (!w) return;
    const l = w.value.toLowerCase();
    if (l === 'exist' || l === 'defined' || l === 'errorlevel') {
      this.readWordSkipWs();
      return;
    }
    if (w.value.includes('==')) return;
    // A op B
    this.readWordSkipWs();
    this.readWordSkipWs();
  }

  private readWordSkipWs(): Word | null {
    while (isWs(this.s[this.i] ?? '')) this.i++;
    const c = this.s[this.i];
    if (c === undefined || c === '\n' || c === '&' || c === '|' || c === ')' || c === '(') return null;
    return this.readWord();
  }

  private readWord(): Word | null {
    const s = this.s;
    const start = this.i;
    let value = '';
    let dynamic = false;
    let glob = false;
    let quoted = false;
    let any = false;
    let inQuote = false;
    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (!inQuote && (isWs(c) || c === '\n' || c === '&' || c === '|' || c === '<' || c === '>' || c === ')' || c === '(')) break;
      any = true;
      if (c === '"') {
        inQuote = !inQuote;
        quoted = true;
        this.i++;
        continue;
      }
      if (c === '^' && !inQuote) {
        if (s[this.i + 1] === undefined) {
          this.i++;
          break;
        }
        value += s[this.i + 1];
        quoted = true;
        this.i += 2;
        continue;
      }
      if (c === '%') {
        const end = s.indexOf('%', this.i + 1);
        const name = end > this.i ? s.slice(this.i + 1, end) : '';
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^\d$/.test(name)) {
          this.i = end + 1;
          if (name.toLowerCase() === 'cd') {
            value += this.ctx.cwd;
            continue;
          }
          const v = this.ctx.vars[name] ?? this.ctx.vars[name.toUpperCase()];
          if (v !== undefined) {
            value += v;
          } else {
            value += '%' + name + '%';
            dynamic = true;
          }
          continue;
        }
      }
      if (c === '!' && !inQuote) {
        const end = s.indexOf('!', this.i + 1);
        if (end > this.i + 1 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(s.slice(this.i + 1, end))) {
          value += s.slice(this.i, end + 1);
          dynamic = true;
          this.i = end + 1;
          continue;
        }
      }
      if (!inQuote && (c === '*' || c === '?')) glob = true;
      value += c;
      this.i++;
    }
    if (inQuote) throw new CmdError('unterminated "');
    if (!any) return null;
    // for-loop variables (%i, %%i) and %~dp0 style modifiers are only known at run time
    if (/^%{1,2}~?[A-Za-z]$/.test(value) || /^%~[a-z]*\d?$/i.test(value)) dynamic = true;
    return { value, raw: s.slice(start, this.i), dynamic, glob, quoted };
  }
}
