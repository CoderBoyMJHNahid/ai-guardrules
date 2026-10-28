import { aiDir } from '../core/project.js';
import { previewShell } from '../core/preview.js';
import { loadGrants, newGrantId, parseDuration, saveGrants } from '../guard/grants.js';
import type { Grant } from '../guard/types.js';
import { CliError, out, pc, table } from '../ui.js';
import { requireInstalled } from './maintain.js';

export interface AllowOptions {
  once?: boolean;
  for?: string;
  path?: boolean;
  create?: boolean;
}

function addGrant(root: string, kind: Grant['kind'], pattern: string, o: AllowOptions): Grant {
  if (!pattern.trim()) throw new CliError('Give a pattern to allow.');
  if (pattern.trim() === '*' && kind === 'command') throw new CliError('A grant of "*" would allow every command. Use a more specific pattern.');
  const grants = loadGrants(aiDir(root));
  const grant: Grant = {
    id: newGrantId(),
    kind,
    pattern: pattern.trim(),
    createdAt: Date.now(),
    expiresAt: o.for ? Date.now() + parseDuration(o.for) : null,
    once: Boolean(o.once),
  };
  grants.push(grant);
  saveGrants(aiDir(root), grants);
  return grant;
}

function describe(g: Grant): string {
  const when = g.once ? 'once' : g.expiresAt ? `until ${new Date(g.expiresAt).toLocaleString()}` : 'until revoked';
  return `${g.kind} "${g.pattern}" (${when})`;
}

export function runAllow(root: string, pattern: string, o: AllowOptions): void {
  requireInstalled(root);
  const kind: Grant['kind'] = o.path ? 'path' : 'command';
  const grant = addGrant(root, kind, pattern, o);
  out.ok(`Allowed ${describe(grant)}  ${pc.dim('id ' + grant.id)}`);
  if (kind === 'command') {
    const r = previewShell(root, pattern, { withGrants: false });
    const hard = r.candidates.filter((c) => !c.grantable);
    if (hard.length) out.warn(`This grant will not help: "${hard[0]?.guard}" is a fixed rule and can never be approved. ${hard[0]?.message}`);
  }
  out.dim('Revoke it with: ai-guardrules grants revoke ' + grant.id);
}

export function runAllowCreate(root: string, pattern: string, o: AllowOptions): void {
  requireInstalled(root);
  const grant = addGrant(root, 'create', pattern, o);
  out.ok(`Allowed ${describe(grant)}  ${pc.dim('id ' + grant.id)}`);
  out.dim('Agents may now create files matching that pattern. Revoke with: ai-guardrules grants revoke ' + grant.id);
}

export function runGrantsList(root: string): void {
  requireInstalled(root);
  const now = Date.now();
  const grants = loadGrants(aiDir(root));
  if (grants.length === 0) {
    out.line('No grants. Everything that needs approval is still asked or blocked.');
    return;
  }
  const rows = grants.map((g) => [g.id, g.kind, g.pattern, g.once ? 'once' : g.expiresAt ? (g.expiresAt > now ? `until ${new Date(g.expiresAt).toLocaleString()}` : 'expired') : 'until revoked']);
  out.line(table([['id', 'kind', 'pattern', 'lasts'], ...rows]));
}

export function runGrantsRevoke(root: string, id: string | undefined, o: { all?: boolean }): void {
  requireInstalled(root);
  const grants = loadGrants(aiDir(root));
  if (o.all) {
    saveGrants(aiDir(root), []);
    out.ok(`Revoked ${grants.length} grant${grants.length === 1 ? '' : 's'}.`);
    return;
  }
  if (!id) throw new CliError('Give a grant id, or use --all. See "ai-guardrules grants list".');
  const left = grants.filter((g) => g.id !== id);
  if (left.length === grants.length) throw new CliError(`No grant with id "${id}".`);
  saveGrants(aiDir(root), left);
  out.ok(`Revoked ${id}.`);
}
