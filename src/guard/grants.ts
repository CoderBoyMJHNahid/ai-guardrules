import fs from 'node:fs';
import path from 'node:path';
import type { Grant } from './types.js';

export interface GrantsFile {
  version: 1;
  grants: Grant[];
}

export function grantsPath(dir: string): string {
  return path.join(dir, 'grants.json');
}

function isGrant(g: unknown): g is Grant {
  if (typeof g !== 'object' || g === null) return false;
  const o = g as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    (o.kind === 'command' || o.kind === 'path' || o.kind === 'create') &&
    typeof o.pattern === 'string' &&
    o.pattern.length > 0 &&
    typeof o.createdAt === 'number' &&
    (o.expiresAt === null || typeof o.expiresAt === 'number') &&
    typeof o.once === 'boolean'
  );
}

/** Missing file means no grants. A corrupt file throws, so the guard fails closed. */
export function loadGrants(dir: string): Grant[] {
  let raw: string;
  try {
    raw = fs.readFileSync(grantsPath(dir), 'utf8');
  } catch {
    return [];
  }
  const data = JSON.parse(raw) as Partial<GrantsFile>;
  if (data.version !== 1 || !Array.isArray(data.grants)) throw new Error('grants.json is malformed');
  return data.grants.filter(isGrant);
}

export function saveGrants(dir: string, grants: Grant[]): void {
  const file = grantsPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, grants } satisfies GrantsFile, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Remove grants that were used once, and any that have expired. */
export function consumeGrants(dir: string, used: Grant[], now = Date.now()): void {
  if (used.length === 0) return;
  const ids = new Set(used.map((g) => g.id));
  const left = loadGrants(dir).filter((g) => !ids.has(g.id) && (g.expiresAt === null || g.expiresAt > now));
  saveGrants(dir, left);
}

export function newGrantId(): string {
  return Math.random().toString(36).slice(2, 8);
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30m", "2h", "1d" -> milliseconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)([smhd])$/.exec(text.trim());
  if (!m) throw new Error(`Invalid duration "${text}". Use something like 30m, 2h or 1d.`);
  return Number(m[1]) * (UNITS[m[2] as string] as number);
}
