import type { EnvAssign, ParseCtx, RawCommand, Redirect, Unresolved, Word } from './model.js';

export interface RawParse {
  raws: RawCommand[];
  unresolved: Unresolved[];
  text: string[];
}

const KEYWORD_SKIP = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'esac', 'while', 'until', '!', '{', '}', 'time', 'coproc']);
const OPERATOR_CHARS = new Set([';', '&', '|', '<', '>', '(', ')']);

class ParseError extends Error {}

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

export function parseBashRaw(src: string, ctx: ParseCtx): RawParse {
  const out: RawParse = { raws: [], unresolved: [], text: [] };
  const p = new BashParser(src, ctx, out);
  try {
    p.parseList(null);
    p.finish();
  } catch (e) {
    if (e instanceof ParseError) {
      out.unresolved.push({ reason: 'parse-error', detail: e.message, severity: 'deny' });
    } else {
      throw e;
    }
  }
  return out;
}

interface PendingHeredoc {
  cmd: RawCommand;
  delim: string;
  stripTabs: boolean;
  expand: boolean;
}

class BashParser {
  i = 0;
  private pendingHeredocs: PendingHeredoc[] = [];
  private lastEmitted: RawCommand | null = null;

  constructor(
    private s: string,
    private ctx: ParseCtx,
    private out: RawParse,
  ) {}

  finish(): void {
    this.consumeHeredocs();
  }

  private peek(o = 0): string {
    return this.s[this.i + o] ?? '';
  }

  private emit(cmd: RawCommand): void {
    this.out.raws.push(cmd);
    this.lastEmitted = cmd;
  }

  private note(reason: string, detail: string, severity: 'deny' | 'ask'): void {
    this.out.unresolved.push({ reason, detail, severity });
  }

  parseList(stop: ')' | null): void {
    const s = this.s;
    let cur: RawCommand | null = null;
    let pipeFrom: RawCommand | null = null;
    let headerSkip: 'none' | 'for' | 'case' | 'function' = 'none';
    let cmdStart = this.i;

    const newCmd = (): RawCommand => {
      cmdStart = this.i;
      return { words: [], env: [], redirects: [], heredocs: [], pipedFrom: pipeFrom, src: '' };
    };
    const flush = (): void => {
      if (cur && (cur.words.length || cur.env.length || cur.redirects.length)) {
        cur.src = s.slice(cmdStart, this.i).trim();
        this.emit(cur);
      }
      cur = null;
      headerSkip = 'none';
    };

    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (c === ' ' || c === '\t' || c === '\r') {
        this.i++;
        continue;
      }
      if (c === '\\' && this.peek(1) === '\n') {
        this.i += 2;
        continue;
      }
      if (c === '#' && (cur === null || cur.words.length === 0 || /\s/.test(s[this.i - 1] ?? ' '))) {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === '\n') {
        flush();
        pipeFrom = null;
        this.i++;
        this.consumeHeredocs();
        continue;
      }
      if (c === ';') {
        flush();
        pipeFrom = null;
        this.i++;
        if (this.peek() === ';' || this.peek() === '&') this.i++;
        continue;
      }
      if (c === '&' && this.peek(1) !== '>') {
        flush();
        pipeFrom = null;
        this.i += this.peek(1) === '&' ? 2 : 1;
        continue;
      }
      if (c === '|') {
        flush();
        if (this.peek(1) === '|') {
          pipeFrom = null;
          this.i += 2;
        } else {
          pipeFrom = this.lastEmitted;
          this.i += this.peek(1) === '&' ? 2 : 1;
        }
        continue;
      }
      if (c === ')') {
        this.i++;
        if (stop === ')') {
          flush();
          return;
        }
        // stray ")" (case pattern or function definition): drop the words before it
        if (cur && cur.words.length) cur = null;
        continue;
      }
      if (c === '(') {
        if (this.peek(1) === '(' && (cur === null || cur.words.length === 0)) {
          this.skipArithmetic();
          continue;
        }
        if (cur && cur.words.length > 0) {
          // function definition: name() { ... }
          this.i++;
          while (this.peek() === ' ') this.i++;
          if (this.peek() === ')') this.i++;
          cur = null;
          continue;
        }
        // subshell
        this.i++;
        this.parseList(')');
        continue;
      }
      if (cur === null) cur = newCmd();
      if (c === '<' || c === '>' || (c === '&' && this.peek(1) === '>') || /\d/.test(c) && this.isFdRedirect()) {
        if ((c === '<' || c === '>') && this.peek(1) === '(') {
          const w = this.readProcSubst();
          cur.words.push(w);
          continue;
        }
        this.readRedirect(cur);
        continue;
      }
      const word = this.readWord();
      if (word === null) {
        // Unknown operator char; skip it so we always make progress.
        this.i++;
        continue;
      }
      if (headerSkip !== 'none') {
        if (headerSkip === 'for' && word.value === 'do' && !word.quoted) headerSkip = 'none';
        else if (headerSkip === 'case' && word.value === 'in' && !word.quoted) headerSkip = 'none';
        else if (headerSkip === 'function') headerSkip = 'none';
        continue;
      }
      if (cur.words.length === 0) {
        if (!word.quoted && ASSIGN_RE.test(word.raw)) {
          const eq = word.raw.indexOf('=');
          const name = word.raw.slice(0, eq).replace(/\+$/, '');
          const valueWord: Word = { ...word, value: word.value.slice(word.value.indexOf('=') + 1), raw: word.raw.slice(eq + 1) };
          cur.env.push({ name, value: valueWord } as EnvAssign);
          continue;
        }
        if (!word.quoted && KEYWORD_SKIP.has(word.value)) continue;
        if (!word.quoted && (word.value === 'for' || word.value === 'select')) {
          headerSkip = 'for';
          continue;
        }
        if (!word.quoted && word.value === 'case') {
          headerSkip = 'case';
          this.note('case-statement', 'case statements are only partially analysed', 'ask');
          continue;
        }
        if (!word.quoted && word.value === 'function') {
          headerSkip = 'function';
          continue;
        }
      }
      cur.words.push(word);
    }
    flush();
    if (stop === ')') throw new ParseError('unterminated ( ... )');
  }

  private isFdRedirect(): boolean {
    let j = this.i;
    while (/\d/.test(this.s[j] ?? '')) j++;
    const ch = this.s[j];
    return ch === '<' || ch === '>';
  }

  private skipArithmetic(): void {
    // (( ... ))
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          this.i++;
          return;
        }
      }
      this.i++;
    }
    throw new ParseError('unterminated (( ... ))');
  }

  private readRedirect(cur: RawCommand): void {
    const s = this.s;
    let fd = '';
    while (/\d/.test(s[this.i] ?? '')) fd += s[this.i++];
    let op = '';
    if (s[this.i] === '&' && s[this.i + 1] === '>') {
      op = '&>';
      this.i += 2;
      if (s[this.i] === '>') {
        op = '&>>';
        this.i++;
      }
    } else if (s[this.i] === '>') {
      op = '>';
      this.i++;
      if (s[this.i] === '>') {
        op = '>>';
        this.i++;
      } else if (s[this.i] === '|') {
        op = '>|';
        this.i++;
      } else if (s[this.i] === '&') {
        op = '>&';
        this.i++;
      }
    } else if (s[this.i] === '<') {
      op = '<';
      this.i++;
      if (s[this.i] === '<') {
        this.i++;
        if (s[this.i] === '<') {
          op = '<<<';
          this.i++;
        } else if (s[this.i] === '-') {
          op = '<<-';
          this.i++;
        } else {
          op = '<<';
        }
      } else if (s[this.i] === '&') {
        op = '<&';
        this.i++;
      } else if (s[this.i] === '>') {
        op = '<>';
        this.i++;
      }
    }
    while (this.peek() === ' ' || this.peek() === '\t') this.i++;
    if (op === '<<' || op === '<<-') {
      const w = this.readWord();
      if (!w) throw new ParseError('heredoc without delimiter');
      const quoted = w.quoted || /["'\\]/.test(w.raw);
      this.pendingHeredocs.push({ cmd: cur, delim: w.value, stripTabs: op === '<<-', expand: !quoted });
      return;
    }
    const target = this.readWord();
    const redirect: Redirect = { op: fd && !op.startsWith('&') ? fd + op : op, target };
    if (target && (op === '>&' || op === '<&') && /^(\d+|-)$/.test(target.value)) return; // fd duplication, not a file
    if (op === '<<<') {
      if (target) {
        this.collectText(target.value);
        cur.heredocs.push(target.value);
      }
      return;
    }
    cur.redirects.push(redirect);
  }

  private consumeHeredocs(): void {
    if (this.pendingHeredocs.length === 0) return;
    const pending = this.pendingHeredocs;
    this.pendingHeredocs = [];
    for (const h of pending) {
      const lines: string[] = [];
      let found = false;
      while (this.i < this.s.length) {
        let end = this.s.indexOf('\n', this.i);
        if (end === -1) end = this.s.length;
        const line = this.s.slice(this.i, end);
        this.i = Math.min(end + 1, this.s.length);
        const cmp = h.stripTabs ? line.replace(/^\t+/, '') : line;
        if (cmp === h.delim) {
          found = true;
          break;
        }
        lines.push(line);
      }
      if (!found) this.note('heredoc-unterminated', h.delim, 'ask');
      const body = lines.join('\n');
      h.cmd.heredocs.push(body);
      this.out.text.push(body);
      if (h.expand) this.extractSubstitutions(body);
    }
  }

  /** Substitutions inside unquoted heredoc bodies run as commands. */
  private extractSubstitutions(text: string): void {
    const sub = new BashParser(text, { ...this.ctx }, this.out);
    let j = 0;
    while (j < text.length) {
      if (text[j] === '$' && text[j + 1] === '(' && text[j + 2] !== '(') {
        const inner = new BashParser(text, this.ctx, this.out);
        inner.i = j + 2;
        try {
          inner.parseList(')');
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          this.note('parse-error', e.message, 'deny');
        }
        j = inner.i;
        continue;
      }
      if (text[j] === '`') {
        const end = text.indexOf('`', j + 1);
        if (end === -1) break;
        this.parseNested(text.slice(j + 1, end));
        j = end + 1;
        continue;
      }
      j++;
    }
    void sub;
  }

  private collectText(t: string): void {
    this.out.text.push(t);
  }

  private parseNested(src: string): void {
    const nested = new BashParser(src, this.ctx, this.out);
    try {
      nested.parseList(null);
      nested.finish();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.note('parse-error', e.message, 'deny');
    }
  }

  private readProcSubst(): Word {
    const start = this.i;
    this.i += 2;
    this.parseList(')');
    return { value: '/dev/fd/63', raw: this.s.slice(start, this.i), dynamic: false, glob: false, quoted: true };
  }

  private varValue(name: string): string | undefined {
    if (name === 'PWD') return this.ctx.cwd;
    return this.ctx.vars[name];
  }

  readWord(): Word | null {
    const s = this.s;
    const start = this.i;
    let value = '';
    let dynamic = false;
    let glob = false;
    let quoted = false;
    let unquotedText = '';
    let any = false;

    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') break;
      if (OPERATOR_CHARS.has(c)) break;
      any = true;
      if (c === '\\') {
        const n = s[this.i + 1];
        if (n === undefined) {
          this.i++;
          break;
        }
        if (n === '\n') {
          this.i += 2;
          continue;
        }
        value += n;
        quoted = true;
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const end = s.indexOf("'", this.i + 1);
        if (end === -1) throw new ParseError("unterminated '");
        value += s.slice(this.i + 1, end);
        quoted = true;
        this.i = end + 1;
        continue;
      }
      if (c === '"') {
        quoted = true;
        this.i++;
        const r = this.readDoubleQuoted();
        value += r.text;
        if (r.dynamic) dynamic = true;
        continue;
      }
      if (c === '`') {
        const end = this.findBacktickEnd(this.i + 1);
        this.parseNested(s.slice(this.i + 1, end).replace(/\\`/g, '`'));
        value += '$(subst)';
        dynamic = true;
        this.i = end + 1;
        continue;
      }
      if (c === '$') {
        const r = this.readDollar(false);
        value += r.text;
        if (r.dynamic) dynamic = true;
        if (r.quoted) quoted = true;
        continue;
      }
      if (c === '*' || c === '?') glob = true;
      if (c === '[' && s.indexOf(']', this.i) !== -1) glob = true;
      value += c;
      unquotedText += c;
      this.i++;
    }
    if (!any) return null;
    if (/\{[^{}\s]*(,|\.\.)[^{}\s]*\}/.test(unquotedText)) dynamic = true;
    return { value, raw: s.slice(start, this.i), dynamic, glob, quoted };
  }

  private findBacktickEnd(from: number): number {
    for (let j = from; j < this.s.length; j++) {
      if (this.s[j] === '\\') {
        j++;
        continue;
      }
      if (this.s[j] === '`') return j;
    }
    throw new ParseError('unterminated `');
  }

  private readDoubleQuoted(): { text: string; dynamic: boolean } {
    const s = this.s;
    let text = '';
    let dynamic = false;
    while (this.i < s.length) {
      const c = s[this.i] as string;
      if (c === '"') {
        this.i++;
        return { text, dynamic };
      }
      if (c === '\\') {
        const n = s[this.i + 1];
        if (n === undefined) break;
        if (n === '\n') {
          this.i += 2;
          continue;
        }
        if (n === '"' || n === '\\' || n === '$' || n === '`') {
          text += n;
        } else {
          text += '\\' + n;
        }
        this.i += 2;
        continue;
      }
      if (c === '`') {
        const end = this.findBacktickEnd(this.i + 1);
        this.parseNested(s.slice(this.i + 1, end).replace(/\\`/g, '`'));
        text += '$(subst)';
        dynamic = true;
        this.i = end + 1;
        continue;
      }
      if (c === '$') {
        const r = this.readDollar(true);
        text += r.text;
        if (r.dynamic) dynamic = true;
        continue;
      }
      text += c;
      this.i++;
    }
    throw new ParseError('unterminated "');
  }

  private readDollar(inDouble: boolean): { text: string; dynamic: boolean; quoted?: boolean } {
    const s = this.s;
    const n = s[this.i + 1];
    if (n === '(') {
      if (s[this.i + 2] === '(') {
        // $(( arithmetic ))
        let depth = 0;
        let j = this.i + 1;
        for (; j < s.length; j++) {
          if (s[j] === '(') depth++;
          else if (s[j] === ')') {
            depth--;
            if (depth === 0) break;
          }
        }
        if (depth !== 0) throw new ParseError('unterminated $(( ))');
        this.i = j + 1;
        return { text: '0', dynamic: true };
      }
      this.i += 2;
      this.parseList(')');
      return { text: '$(subst)', dynamic: true };
    }
    if (n === '{') {
      let depth = 0;
      let j = this.i + 1;
      for (; j < s.length; j++) {
        if (s[j] === '{') depth++;
        else if (s[j] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) throw new ParseError('unterminated ${ }');
      const inner = s.slice(this.i + 2, j);
      this.i = j + 1;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)) {
        const v = this.varValue(inner);
        if (v !== undefined) return { text: v, dynamic: false };
      }
      return { text: '${' + inner + '}', dynamic: true };
    }
    if (n === "'" && !inDouble) {
      const end = this.findAnsiEnd(this.i + 2);
      const text = decodeAnsiC(s.slice(this.i + 2, end));
      this.i = end + 1;
      return { text, dynamic: false, quoted: true };
    }
    if (n === '"' && !inDouble) {
      this.i += 2;
      const r = this.readDoubleQuoted();
      return { text: r.text, dynamic: r.dynamic, quoted: true };
    }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      let j = this.i + 1;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j] as string)) j++;
      const name = s.slice(this.i + 1, j);
      this.i = j;
      const v = this.varValue(name);
      if (v !== undefined) return { text: v, dynamic: false };
      return { text: '$' + name, dynamic: true };
    }
    if (n !== undefined && /[0-9@*?#!$-]/.test(n)) {
      this.i += 2;
      return { text: '$' + n, dynamic: true };
    }
    this.i++;
    return { text: '$', dynamic: false };
  }

  private findAnsiEnd(from: number): number {
    for (let j = from; j < this.s.length; j++) {
      if (this.s[j] === '\\') {
        j++;
        continue;
      }
      if (this.s[j] === "'") return j;
    }
    throw new ParseError("unterminated $'");
  }
}

export function decodeAnsiC(t: string): string {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i] as string;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = t[++i];
    switch (n) {
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'e':
      case 'E': out += '\x1b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case "'": out += "'"; break;
      case '"': out += '"'; break;
      case '?': out += '?'; break;
      case 'x': {
        const m = /^[0-9a-fA-F]{1,2}/.exec(t.slice(i + 1));
        if (m) {
          out += String.fromCharCode(parseInt(m[0], 16));
          i += m[0].length;
        } else out += '\\x';
        break;
      }
      case 'u':
      case 'U': {
        const max = n === 'u' ? 4 : 8;
        const m = new RegExp(`^[0-9a-fA-F]{1,${max}}`).exec(t.slice(i + 1));
        if (m) {
          out += String.fromCodePoint(parseInt(m[0], 16));
          i += m[0].length;
        } else out += '\\' + n;
        break;
      }
      default: {
        if (n !== undefined && /[0-7]/.test(n)) {
          const m = /^[0-7]{1,3}/.exec(t.slice(i));
          if (m) {
            out += String.fromCharCode(parseInt(m[0], 8));
            i += m[0].length - 1;
          }
        } else if (n !== undefined) {
          out += '\\' + n;
        }
      }
    }
  }
  return out;
}
