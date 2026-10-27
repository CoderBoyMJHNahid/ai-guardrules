import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Change, ToolId } from '../adapters/types.js';
import { LOCKED_FILES, lockFromContents } from '../guard/integrity.js';
import { GUARD_NAMES, HARD_GUARD_NAMES, presetPolicy, validatePolicy } from '../guard/policy.js';
import type { Policy } from '../guard/types.js';
import { makeReadOnly, pruneEmptyDirs, readText, removeFile, writeFileAtomic } from './fsutil.js';
import { newJson } from './json.js';
import type { PresetName } from './rules-text.js';
import { removeLinesBlock, upsertLinesBlock } from './textblock.js';

export const AI_DIR = '.ai-rules';

export interface Manifest {
  version: 1;
  packageVersion: string;
  preset: PresetName;
  tools: ToolId[];
  localWrapper: boolean;
}

export function aiDir(root: string): string {
  return path.join(root, AI_DIR);
}

export function aiPath(root: string, rel: string): string {
  return path.join(root, AI_DIR, ...rel.split('/'));
}

// ---------------------------------------------------------------------------
// Package location
// ---------------------------------------------------------------------------

function findPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pj = path.join(dir, 'package.json');
    try {
      const j = JSON.parse(fs.readFileSync(pj, 'utf8')) as { name?: string };
      if (j.name === 'ai-rules') return dir;
    } catch {
      /* keep walking */
    }
    dir = path.dirname(dir);
  }
  throw new Error('Cannot locate the ai-rules package files.');
}

export function packageVersion(): string {
  const j = JSON.parse(fs.readFileSync(path.join(findPackageRoot(), 'package.json'), 'utf8')) as { version: string };
  return j.version;
}

export function guardSource(): string {
  const p = path.join(findPackageRoot(), 'dist', 'guard.mjs');
  if (!fs.existsSync(p)) throw new Error('dist/guard.mjs is missing. Run "npm run build" first.');
  return p;
}

// ---------------------------------------------------------------------------
// Reading project state
// ---------------------------------------------------------------------------

export function readManifest(root: string): Manifest | null {
  const t = readText(aiPath(root, 'manifest.json'));
  if (t === null) return null;
  try {
    const m = JSON.parse(t) as Manifest;
    if (m.version !== 1 || !Array.isArray(m.tools)) return null;
    return m;
  } catch {
    return null;
  }
}

export function readPolicy(root: string): Policy | null {
  const t = readText(aiPath(root, 'policy.json'));
  if (t === null) return null;
  return validatePolicy(JSON.parse(t));
}

/** Notes the user wrote in .ai-rules/custom/rules.md (HTML comments are ignored). */
export function readCustomRules(root: string): string {
  const t = readText(aiPath(root, 'custom/rules.md')) ?? '';
  return t.replace(/<!--[\s\S]*?-->/g, '').trim();
}

export function isInstalled(root: string): boolean {
  return fs.existsSync(aiPath(root, 'guard.mjs'));
}

// ---------------------------------------------------------------------------
// Policy merge (update keeps the user's choices)
// ---------------------------------------------------------------------------

function union(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

export function mergePolicy(existing: Policy | null, preset: PresetName, presetChanged: boolean): Policy {
  const fresh = presetPolicy(preset);
  if (!existing || presetChanged) return fresh;
  const guards = { ...existing.guards };
  for (const g of GUARD_NAMES) {
    if (guards[g] === undefined) guards[g] = fresh.guards[g] as Policy['guards'][string];
  }
  for (const g of HARD_GUARD_NAMES) guards[g] = fresh.guards[g] as Policy['guards'][string];
  return {
    ...existing,
    version: 1,
    guards,
    protected: union(existing.protected, fresh.protected),
    secrets: { paths: union(existing.secrets.paths, fresh.secrets.paths), allow: existing.secrets.allow },
    database: { commands: union(existing.database.commands, fresh.database.commands), mcpPatterns: union(existing.database.mcpPatterns, fresh.database.mcpPatterns) },
    safeTools: union(existing.safeTools, fresh.safeTools),
  };
}

// ---------------------------------------------------------------------------
// Planning core files
// ---------------------------------------------------------------------------

export const READ_ONLY_FILES = ['guard.mjs', 'policy.json', 'lock.json', 'custom/guards.json', 'custom/hooks.json'];

const GITATTRIBUTES = ['.ai-rules/** -text eol=lf'];
const GITIGNORE = ['.ai-rules/grants.json', '.ai-rules/backups/'];

function fileChange(root: string, rel: string, after: string | null, note: string): Change | null {
  const before = readText(path.join(root, rel));
  return before === after ? null : { file: rel, before, after, note };
}

export interface CorePlan {
  changes: Change[];
  policy: Policy;
  manifest: Manifest;
}

export function planCore(root: string, o: { preset: PresetName; tools: ToolId[]; localWrapper: boolean; presetChanged: boolean }): CorePlan {
  const existingPolicy = readPolicy(root);
  // validatePolicy fixes the key order so repeated runs produce identical bytes.
  const policy = validatePolicy(mergePolicy(existingPolicy, o.preset, o.presetChanged));
  const guardText = fs.readFileSync(guardSource(), 'utf8');
  const manifest: Manifest = { version: 1, packageVersion: packageVersion(), preset: o.preset, tools: o.tools, localWrapper: o.localWrapper };
  const policyText = newJson(policy);

  const contents: Record<string, string | null> = {};
  for (const rel of LOCKED_FILES) contents[rel] = readText(aiPath(root, rel));
  contents['guard.mjs'] = guardText;
  contents['policy.json'] = policyText;

  const changes: Change[] = [];
  const push = (c: Change | null): void => {
    if (c) changes.push(c);
  };
  push(fileChange(root, `${AI_DIR}/guard.mjs`, guardText, 'enforcement script (zero dependencies)'));
  push(fileChange(root, `${AI_DIR}/policy.json`, policyText, 'policy'));
  push(fileChange(root, `${AI_DIR}/manifest.json`, newJson(manifest), 'install record'));
  push(fileChange(root, `${AI_DIR}/lock.json`, newJson(lockFromContents(contents)), 'integrity hashes'));
  push(fileChange(root, '.gitattributes', upsertLinesBlock(readText(path.join(root, '.gitattributes')), GITATTRIBUTES), 'keep guard files on LF line endings'));
  push(fileChange(root, '.gitignore', upsertLinesBlock(readText(path.join(root, '.gitignore')), GITIGNORE), 'ignore machine-local grants and backups'));
  return { changes, policy, manifest };
}

// ---------------------------------------------------------------------------
// Applying changes
// ---------------------------------------------------------------------------

export interface Applied {
  file: string;
  action: 'created' | 'updated' | 'removed';
}

function backupName(rel: string): string {
  return rel.replace(/[\\/]/g, '__');
}

/** Write planned changes. Pre-existing user files get a one-time backup in .ai-rules/backups/. */
export function applyChanges(root: string, changes: Change[], o: { dryRun?: boolean } = {}): Applied[] {
  const applied: Applied[] = [];
  for (const c of changes) {
    const file = path.join(root, ...c.file.split('/'));
    const action: Applied['action'] = c.after === null ? 'removed' : c.before === null ? 'created' : 'updated';
    applied.push({ file: c.file, action });
    if (o.dryRun) continue;
    if (c.before !== null && !c.file.startsWith(`${AI_DIR}/`) && !c.before.includes('ai-rules')) {
      const dir = path.join(root, AI_DIR, 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${backupName(c.file)}.${Date.now()}.bak`);
      if (!fs.readdirSync(dir).some((n) => n.startsWith(backupName(c.file) + '.'))) fs.writeFileSync(target, c.before);
    }
    if (c.after === null) {
      removeFile(file);
      pruneEmptyDirs(path.dirname(file), root);
    } else {
      writeFileAtomic(file, c.after);
    }
  }
  if (!o.dryRun) {
    for (const rel of READ_ONLY_FILES) {
      const f = aiPath(root, rel);
      if (fs.existsSync(f)) makeReadOnly(f);
    }
  }
  return applied;
}

/** Rebuild lock.json from the files currently on disk. */
export function relock(root: string): void {
  const contents: Record<string, string | null> = {};
  for (const rel of LOCKED_FILES) contents[rel] = readText(aiPath(root, rel));
  writeFileAtomic(aiPath(root, 'lock.json'), newJson(lockFromContents(contents)));
  makeReadOnly(aiPath(root, 'lock.json'));
}

/** Write one locked file, then refresh the lock. */
export function writeLocked(root: string, rel: string, content: string): void {
  writeFileAtomic(aiPath(root, rel), content);
  if (READ_ONLY_FILES.includes(rel)) makeReadOnly(aiPath(root, rel));
  relock(root);
}

/** Plan removal of everything ai-rules created in the project-level shared files. */
export function planRemoveCore(root: string): Change[] {
  const out: Change[] = [];
  for (const [rel, remove] of [
    ['.gitattributes', removeLinesBlock],
    ['.gitignore', removeLinesBlock],
  ] as const) {
    const before = readText(path.join(root, rel));
    if (before === null) continue;
    const after = remove(before);
    if (after !== before) out.push({ file: rel, before, after, note: 'ai-rules block' });
  }
  return out;
}
