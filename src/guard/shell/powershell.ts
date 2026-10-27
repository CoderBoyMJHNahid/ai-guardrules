import type { RawParse } from './bash.js';
import type { ParseCtx, RawCommand, Redirect, Word } from './model.js';

const CONTROL_KEYWORDS = new Set(['if', 'elseif', 'else', 'foreach', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'function', 'filter', 'param', 'begin', 'process', 'end', 'return', 'throw', 'trap', 'until', 'data', 'using', 'exit', 'break', 'continue']);
const HEADER_KEYWORDS = new Set(['if', 'elseif', 'while', 'until', 'switch', 'for', 'foreach', 'catch']);

class PsError extends Error {}

export function parsePowerShellRaw(src: string, ctx: ParseCtx): RawParse {
  const out: RawParse = { raws: [], unresolved: [], text: [] };
  const p = new PsParser(src, ctx, out, false);
  try {
    p.parseList(null);
  } catch (e) {
    if (e instanceof PsError) out.unresolved.push({ reason: 'parse-error', detail: e.message, severity: 'deny' });
    else throw e;
  }
  return out;
}

const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\r';

class PsParser {
  i = 0;
  private lastEmitted: RawCommand | null = null;

  constructor(
    private s: string,
    private ctx: ParseCtx,
    private out: RawParse,
    private lenient: boolean,
  ) {}

  private peek(o = 0): string {
    return this.s[this.i + o] ?? '';
  }

  private emit(c: RawCommand): void {
    if (this.lenient) {
      const first = c.words[0];
      if (!first || /^[$[\d'"@(\-+*/%]/.test(first.raw) || first.dynamic) {
        // Expression (variables, arithmetic, literals), not a command.
        return;
      }
    }
    this.out.raws.push(c);
    this.lastEmitted = c;
  }

  private nested(open: '(' | '{', close: ')' | '}', lenient = true): void {
    const sub = new PsParser(this.s, this.ctx, this.out, lenient);
    sub.i = this.i;
    sub.parseList(close);
    this.i = sub.i;
    void open;
  }

  parseList(stop: ')' | '}' | null): void {
    const s = this.s;
    let cur: RawCommand | null = null;
    let pipeFrom: RawCommand | null = null;
    let cmdStart = this.i;
    let headerPending = false;
    const newCmd = (): RawCommand => {
      cmdStart = this.i;
      return { words: [], env: [], redirects: [], heredocs: [], pipedFrom: pipeFrom, src: '' };
    };
    const flush = (): void => {
      if (cur && (cur.words.length || cur.redirects.length)) {
        cur.src = s.slice(cmdStart, this.i).trim();
        this.emit(cur);
      }
      cur = null;
    };

    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (isWs(c)) {
        this.i++;
        continue;
      }
      if (c === '`' && this.peek(1) === '\n') {
        this.i += 2;
        continue;
      }
      if (c === '<' && this.peek(1) === '#') {
        const end = s.indexOf('#>', this.i + 2);
        if (end === -1) throw new PsError('unterminated block comment');
        this.i = end + 2;
        continue;
      }
      if (c === '#' && (cur === null || cur.words.length === 0 || isWs(s[this.i - 1] ?? ' '))) {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === '\n' || c === ';') {
        flush();
        pipeFrom = null;
        headerPending = false;
        this.i++;
        continue;
      }
      if (c === '&' && this.peek(1) === '&') {
        flush();
        pipeFrom = null;
        this.i += 2;
        continue;
      }
      if (c === '|') {
        flush();
        if (this.peek(1) === '|') {
          pipeFrom = null;
          this.i += 2;
        } else {
          pipeFrom = this.lastEmitted;
          this.i++;
        }
        continue;
      }
      if (c === ')' || c === '}') {
        this.i++;
        if (stop === c) {
          flush();
          return;
        }
        if (c === '}') {
          // closing a block we did not open here (e.g. consumed by headerPending); ignore
          flush();
          continue;
        }
        flush();
        continue;
      }
      if (c === '(') {
        this.i++;
        const wasHeader = headerPending;
        headerPending = false;
        this.nested('(', ')', true);
        if (cur) cur.words.push({ value: '(expr)', raw: '(expr)', dynamic: true, glob: false, quoted: false });
        else if (!wasHeader) {
          cur = newCmd();
          cur.words.push({ value: '(expr)', raw: '(expr)', dynamic: true, glob: false, quoted: false });
        }
        continue;
      }
      if (c === '{') {
        this.i++;
        this.nested('{', '}', true);
        if (cur) cur.words.push({ value: '{block}', raw: '{block}', dynamic: false, glob: false, quoted: true });
        continue;
      }
      if (cur === null) cur = newCmd();
      // Redirections
      const redir = this.tryRedirect(cur);
      if (redir) continue;
      // Here-strings
      if ((c === '@' && (this.peek(1) === "'" || this.peek(1) === '"')) && (this.peek(2) === '\n' || this.peek(2) === '\r')) {
        const quote = this.peek(1);
        const end = s.indexOf('\n' + quote + '@', this.i + 2);
        if (end === -1) throw new PsError('unterminated here-string');
        const body = s.slice(this.i + 3, end);
        this.out.text.push(body);
        cur.words.push({ value: body, raw: body, dynamic: quote === '"', glob: false, quoted: true });
        this.i = end + 3;
        continue;
      }
      const word = this.readWord();
      if (word === null) {
        this.i++;
        continue;
      }
      if (cur.words.length === 0) {
        const lower = word.value.toLowerCase();
        if (!word.quoted && (word.value === '&' || word.value === '.')) {
          // call operator / dot-sourcing
          const next = this.peekWordStart();
          if (word.value === '.' && next) {
            this.out.unresolved.push({ reason: 'dot-source', detail: s.slice(cmdStart, Math.min(s.length, this.i + 40)), severity: 'deny' });
          }
          if (word.value === '&' && next && (next === '$' || next === '(')) {
            this.out.unresolved.push({ reason: 'dynamic-command', detail: 'call operator on a dynamic value', severity: 'deny' });
          }
          continue;
        }
        if (!word.quoted && CONTROL_KEYWORDS.has(lower)) {
          if (HEADER_KEYWORDS.has(lower)) headerPending = true;
          continue;
        }
        if (/^\[/.test(word.raw) && !word.quoted) {
          // [System.IO.File]::Delete(...) style .NET expression: capture the statement as inline code.
          const stmtEnd = this.findStatementEnd();
          const code = s.slice(this.i - word.raw.length, stmtEnd);
          this.i = stmtEnd;
          cur.words.push({ value: ':net', raw: ':net', dynamic: false, glob: false, quoted: false });
          cur.words.push({ value: code, raw: code, dynamic: false, glob: false, quoted: true });
          this.out.text.push(code);
          flush();
          continue;
        }
        if (word.dynamic && /^\$/.test(word.raw) && !word.quoted) {
          // $x = <expr>  (assignment): restart command position after the operator
          const save = this.i;
          while (isWs(this.peek())) this.i++;
          const m = /^(\+|-|\*|\/)?=/.exec(s.slice(this.i, this.i + 2));
          if (m) {
            this.i += m[0].length;
            cur = null;
            continue;
          }
          this.i = save;
        }
      }
      cur.words.push(word);
    }
    flush();
    if (stop !== null) throw new PsError('unterminated group');
  }

  private peekWordStart(): string {
    let j = this.i;
    while (isWs(this.s[j] ?? '')) j++;
    return this.s[j] ?? '';
  }

  private findStatementEnd(): number {
    let j = this.i;
    let depth = 0;
    let quote = '';
    for (; j < this.s.length; j++) {
      const c = this.s[j] as string;
      if (quote) {
        if (c === quote) quote = '';
        continue;
      }
      if (c === "'" || c === '"') quote = c;
      else if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) break;
        depth--;
      } else if ((c === ';' || c === '\n' || c === '|') && depth === 0) break;
    }
    return j;
  }

  private tryRedirect(cur: RawCommand): boolean {
    const s = this.s;
    const m = /^(\d|\*)?(>>|>|<)(&\d)?/.exec(s.slice(this.i, this.i + 5));
    if (!m) return false;
    // "2>&1"-style duplication is not a file.
    if (m[3]) {
      this.i += m[0].length;
      return true;
    }
    this.i += m[0].length;
    while (isWs(this.peek())) this.i++;
    const target = this.readWord();
    const redirect: Redirect = { op: m[0], target };
    if (m[2] !== '<') cur.redirects.push(redirect);
    return true;
  }

  private readWord(): Word | null {
    const s = this.s;
    const start = this.i;
    let value = '';
    let dynamic = false;
    let glob = false;
    let quoted = false;
    let any = false;
    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (isWs(c) || c === '\n' || c === ';' || c === '|' || c === ')' || c === '}' || c === '{' || c === '(' || c === '>' || c === '<') break;
      any = true;
      if (c === '`') {
        const n = s[this.i + 1];
        if (n === undefined) {
          this.i++;
          break;
        }
        if (n === '\n') {
          this.i += 2;
          continue;
        }
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
        value += map[n] ?? n;
        quoted = true;
        this.i += 2;
        continue;
      }
      if (c === "'") {
        this.i++;
        let t = '';
        for (;;) {
          if (this.i >= s.length) throw new PsError("unterminated '");
          if (s[this.i] === "'") {
            if (s[this.i + 1] === "'") {
              t += "'";
              this.i += 2;
              continue;
            }
            this.i++;
            break;
          }
          t += s[this.i++];
        }
        value += t;
        quoted = true;
        continue;
      }
      if (c === '"') {
        this.i++;
        quoted = true;
        const r = this.readDouble();
        value += r.text;
        if (r.dynamic) dynamic = true;
        continue;
      }
      if (c === '$') {
        const r = this.readVar();
        value += r.text;
        if (r.dynamic) dynamic = true;
        continue;
      }
      if (c === '@' && s[this.i + 1] === '(') {
        this.i += 2;
        this.nested('(', ')', true);
        value += '@(expr)';
        dynamic = true;
        continue;
      }
      if (c === '*' || c === '?') glob = true;
      if (c === '[' && s.indexOf(']', this.i) !== -1) glob = true;
      value += c;
      this.i++;
    }
    if (!any) return null;
    return { value, raw: s.slice(start, this.i), dynamic, glob, quoted };
  }

  private readDouble(): { text: string; dynamic: boolean } {
    const s = this.s;
    let text = '';
    let dynamic = false;
    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (c === '"') {
        if (s[this.i + 1] === '"') {
          text += '"';
          this.i += 2;
          continue;
        }
        this.i++;
        return { text, dynamic };
      }
      if (c === '`') {
        const n = s[this.i + 1];
        if (n === undefined) break;
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
        text += map[n] ?? n;
        this.i += 2;
        continue;
      }
      if (c === '$') {
        const r = this.readVar();
        text += r.text;
        if (r.dynamic) dynamic = true;
        continue;
      }
      text += c;
      this.i++;
    }
    throw new PsError('unterminated "');
  }

  private readVar(): { text: string; dynamic: boolean } {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === '(') {
      this.i += 2;
      this.nested('(', ')', true);
      return { text: '$(expr)', dynamic: true };
    }
    if (n === '{') {
      const end = s.indexOf('}', this.i + 2);
      if (end === -1) throw new PsError('unterminated ${');
      const name = s.slice(this.i + 2, end);
      this.i = end + 1;
      return this.lookup(name);
    }
    const m = /^\$((?:env|global|script|local|private):)?([A-Za-z_?][A-Za-z0-9_]*)?/.exec(s.slice(this.i));
    if (m && (m[2] || m[1])) {
      this.i += m[0].length;
      return this.lookup((m[1] ?? '') + (m[2] ?? ''));
    }
    if (n !== undefined && /[_$?^]/.test(n)) {
      this.i += 2;
      return { text: '$' + n, dynamic: true };
    }
    this.i++;
    return { text: '$', dynamic: false };
  }

  private lookup(name: string): { text: string; dynamic: boolean } {
    const lower = name.toLowerCase();
    if (lower === 'pwd') return { text: this.ctx.cwd, dynamic: false };
    if (lower === 'null') return { text: '$null', dynamic: false };
    let key = name;
    if (lower.startsWith('env:')) key = name.slice(4);
    const v = this.ctx.vars[key] ?? this.ctx.vars[key.toUpperCase()];
    if (v !== undefined && (lower.startsWith('env:') || lower === 'home' || lower === 'userprofile')) return { text: v, dynamic: false };
    return { text: '$' + name, dynamic: true };
  }
}
