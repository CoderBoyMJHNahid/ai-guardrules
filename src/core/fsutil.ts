import fs from 'node:fs';
import path from 'node:path';

export function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function exists(file: string): boolean {
  return fs.existsSync(file);
}

export function isDir(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function posix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function detectEol(text: string | null): '\r\n' | '\n' {
  return text !== null && /\r\n/.test(text) ? '\r\n' : '\n';
}

export function toEol(text: string, eol: '\r\n' | '\n'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/** Read-only on every platform (Node maps a missing write bit to the Windows read-only attribute). */
export function makeReadOnly(file: string): void {
  try {
    fs.chmodSync(file, 0o444);
  } catch {
    /* best effort */
  }
}

export function makeWritable(file: string): void {
  try {
    fs.chmodSync(file, 0o644);
  } catch {
    /* best effort */
  }
}

export function isReadOnly(file: string): boolean {
  try {
    return (fs.statSync(file).mode & 0o222) === 0;
  } catch {
    return false;
  }
}

export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = exists(file);
  if (existed) makeWritable(file);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function removeFile(file: string): void {
  if (!exists(file)) return;
  makeWritable(file);
  fs.rmSync(file, { force: true });
}

/** Remove empty directories upward, stopping at (and excluding) `stop`. */
export function pruneEmptyDirs(dir: string, stop: string): void {
  let cur = dir;
  while (cur !== stop && cur.startsWith(stop)) {
    try {
      if (fs.readdirSync(cur).length > 0) return;
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}
