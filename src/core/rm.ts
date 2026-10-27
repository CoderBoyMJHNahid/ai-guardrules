import fs from 'node:fs';
import path from 'node:path';

/** Clear read-only bits under a directory so it can be deleted (needed on Windows). */
export function makeWritableTree(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) makeWritableTree(full);
    else {
      try {
        fs.chmodSync(full, 0o644);
      } catch {
        /* ignore */
      }
    }
  }
}
