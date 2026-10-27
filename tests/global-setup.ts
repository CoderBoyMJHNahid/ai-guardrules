import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Build the CLI and the standalone guard once, so e2e and contract tests can run them. */
export default function setup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const guard = path.join(root, 'dist', 'guard.mjs');
  const cli = path.join(root, 'dist', 'cli.js');
  const srcNewest = newest(path.join(root, 'src'));
  const built = fs.existsSync(guard) && fs.existsSync(cli) ? Math.min(fs.statSync(guard).mtimeMs, fs.statSync(cli).mtimeMs) : 0;
  if (built < srcNewest) {
    try {
      execSync('npx tsup', { cwd: root, stdio: 'inherit' });
    } catch (e) {
      // Unit tests do not need the build; e2e tests will fail loudly if it is missing.
      console.warn('tsup build failed:', (e as Error).message);
    }
  }
}

function newest(dir: string): number {
  let max = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    max = Math.max(max, entry.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return max;
}
