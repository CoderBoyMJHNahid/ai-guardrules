import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Files inside `.ai-rules/` whose content is locked. grants.json and lock.json change at runtime. */
export const LOCKED_FILES = ['guard.mjs', 'policy.json', 'custom/guards.json', 'custom/hooks.json', 'custom/rules.md'] as const;

export interface LockFile {
  version: 1;
  files: Record<string, string>;
}

/** Line endings must not change the hash (git autocrlf on Windows). */
export function hashBuffer(buf: Buffer): string {
  const text = buf.toString('latin1').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text, 'latin1').digest('hex');
}

export function hashText(text: string): string {
  return hashBuffer(Buffer.from(text, 'utf8'));
}

export function hashFile(file: string): string | null {
  try {
    return hashBuffer(fs.readFileSync(file));
  } catch {
    return null;
  }
}

export function buildLock(dir: string): LockFile {
  const files: Record<string, string> = {};
  for (const rel of LOCKED_FILES) {
    const h = hashFile(path.join(dir, rel));
    if (h) files[rel] = h;
  }
  return { version: 1, files };
}

export function lockFromContents(contents: Record<string, string | null>): LockFile {
  const files: Record<string, string> = {};
  for (const rel of LOCKED_FILES) {
    const c = contents[rel];
    if (c !== undefined && c !== null) files[rel] = hashText(c);
  }
  return { version: 1, files };
}

export interface LockCheck {
  ok: boolean;
  problems: string[];
}

export function verifyLock(dir: string): LockCheck {
  const problems: string[] = [];
  let lock: LockFile;
  try {
    lock = JSON.parse(fs.readFileSync(path.join(dir, 'lock.json'), 'utf8')) as LockFile;
    if (lock.version !== 1 || typeof lock.files !== 'object' || lock.files === null) throw new Error('bad lock');
  } catch {
    return { ok: false, problems: ['lock.json is missing or unreadable'] };
  }
  for (const rel of LOCKED_FILES) {
    const expected = lock.files[rel];
    const actual = hashFile(path.join(dir, rel));
    if (expected === undefined && actual === null) continue;
    if (expected === undefined) problems.push(`${rel} was added after the lock was created`);
    else if (actual === null) problems.push(`${rel} is missing`);
    else if (expected !== actual) problems.push(`${rel} was modified`);
  }
  for (const rel of Object.keys(lock.files)) {
    if (!(LOCKED_FILES as readonly string[]).includes(rel)) problems.push(`${rel} is not a recognised locked file`);
  }
  return { ok: problems.length === 0, problems };
}
