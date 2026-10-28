import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGuard } from '../src/core/runGuard.js';
import { isAsking, isBlocked, samplePayload } from '../src/core/samples.js';
import { normalize, render } from '../src/guard/normalize.js';
import { installProject, type Installed } from './harness.js';

/**
 * Contract tests: documented hook payloads go through the real built guard.mjs as a process,
 * the way each agent calls it. Fixtures follow docs/agent-schemas.md (not live captures).
 */

let strict: Installed;
let standard: Installed;
beforeAll(() => {
  strict = installProject('strict');
  standard = installProject('standard');
});
afterAll(() => {
  strict.cleanup();
  standard.cleanup();
});

const AGENTS = ['claude', 'cursor', 'gemini', 'windsurf', 'codex'] as const;

describe.each(AGENTS)('%s contract', (agent) => {
  it('blocks git push in strict', () => {
    const r = runGuard(strict.guard, agent, samplePayload(agent, 'shell', 'git push origin main', strict.root), strict.root);
    expect(isBlocked(agent, r), JSON.stringify(r)).toBe(true);
    expect(r.stderr + r.stdout).toContain('ai-guardrules');
  });

  it('blocks reading .env with the file tool', () => {
    const r = runGuard(strict.guard, agent, samplePayload(agent, 'read', path.join(strict.root, '.env'), strict.root), strict.root);
    expect(isBlocked(agent, r)).toBe(true);
  });

  it('allows reading a normal file', () => {
    const r = runGuard(strict.guard, agent, samplePayload(agent, 'read', path.join(strict.root, 'src', 'a.ts'), strict.root), strict.root);
    expect(isBlocked(agent, r), JSON.stringify(r)).toBe(false);
    expect(isAsking(agent, r)).toBe(false);
  });

  it('blocks creating a new file when it cannot ask, asks or blocks otherwise', () => {
    const r = runGuard(strict.guard, agent, samplePayload(agent, 'write', path.join(strict.root, 'brand-new.txt'), strict.root), strict.root);
    expect(isBlocked(agent, r) || isAsking(agent, r)).toBe(true);
  });

  it('lets existing files be edited', () => {
    const r = runGuard(strict.guard, agent, samplePayload(agent, 'write', path.join(strict.root, 'existing.txt'), strict.root), strict.root);
    expect(isBlocked(agent, r), JSON.stringify(r)).toBe(false);
  });

  it('allows read-only git without a prompt', () => {
    const r = runGuard(strict.guard, agent, samplePayload(agent, 'shell', 'git status', strict.root), strict.root);
    expect(isBlocked(agent, r)).toBe(false);
    expect(isAsking(agent, r)).toBe(false);
  });

  it('blocks database deletes through MCP', () => {
    const r = runGuard(standard.guard, agent, samplePayload(agent, 'mcp', 'DROP TABLE users', standard.root), standard.root);
    expect(isBlocked(agent, r), JSON.stringify(r)).toBe(true);
  });

  it('standard preset lets ordinary commands run', () => {
    const r = runGuard(standard.guard, agent, samplePayload(agent, 'shell', 'npm test', standard.root), standard.root);
    expect(isBlocked(agent, r)).toBe(false);
    expect(isAsking(agent, r)).toBe(false);
  });

  it('fails closed on garbage, empty and truncated input', () => {
    for (const input of ['', 'not json', '{"tool_name":', '[]', 'null', '{}']) {
      const r = runGuard(strict.guard, agent, input, strict.root);
      expect(isBlocked(agent, r), `input ${JSON.stringify(input)} -> ${JSON.stringify(r)}`).toBe(true);
    }
  });
});

describe('agent-specific output', () => {
  it('claude asks for ordinary commands and exits 0 with JSON', () => {
    const r = runGuard(strict.guard, 'claude', samplePayload('claude', 'shell', 'npm test', strict.root), strict.root);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('claude prints nothing when the guard has no opinion', () => {
    const r = runGuard(standard.guard, 'claude', samplePayload('claude', 'shell', 'npm test', standard.root), standard.root);
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
  });

  it('claude explicitly allows read-only git', () => {
    const r = runGuard(strict.guard, 'claude', samplePayload('claude', 'shell', 'git log --oneline', strict.root), strict.root);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('cursor asks for commands in beforeShellExecution but denies in preToolUse', () => {
    const shell = runGuard(strict.guard, 'cursor', samplePayload('cursor', 'shell', 'npm test', strict.root), strict.root);
    expect(JSON.parse(shell.stdout).permission).toBe('ask');
    const write = runGuard(strict.guard, 'cursor', samplePayload('cursor', 'write', path.join(strict.root, 'new.txt'), strict.root), strict.root);
    expect(JSON.parse(write.stdout).permission).toBe('deny');
  });

  it('cursor always prints a permission', () => {
    const r = runGuard(standard.guard, 'cursor', samplePayload('cursor', 'shell', 'npm test', standard.root), standard.root);
    expect(JSON.parse(r.stdout).permission).toBe('allow');
  });

  it('cursor preToolUse ignores Shell and MCP (handled by dedicated hooks)', () => {
    const payload = { hook_event_name: 'preToolUse', workspace_roots: [strict.root], tool_name: 'Shell', tool_input: { command: 'git push' } };
    const r = runGuard(strict.guard, 'cursor', payload, strict.root);
    expect(JSON.parse(r.stdout).permission).toBe('allow');
  });

  it('gemini blocks with exit 2 and a readable reason', () => {
    const r = runGuard(strict.guard, 'gemini', samplePayload('gemini', 'shell', 'npm test', strict.root), strict.root);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cannot prompt/);
    expect(r.stderr).toMatch(/ai-guardrules allow/);
  });

  it('codex parses apply_patch into file checks', () => {
    const patch = (body: string) => ({ session_id: 's', cwd: strict.root, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` } });
    expect(isBlocked('codex', runGuard(strict.guard, 'codex', patch('*** Delete File: existing.txt'), strict.root))).toBe(true);
    expect(isBlocked('codex', runGuard(strict.guard, 'codex', patch('*** Update File: .ai-guardrules/policy.json\n@@\n-a\n+b'), strict.root))).toBe(true);
    expect(isBlocked('codex', runGuard(strict.guard, 'codex', patch('*** Update File: existing.txt\n@@\n-x\n+y'), strict.root))).toBe(false);
    expect(isBlocked('codex', runGuard(strict.guard, 'codex', patch('*** Update File: a.txt\n*** Move to: ../elsewhere.txt'), strict.root))).toBe(true);
  });

  it('claude handles MCP tool names', () => {
    const payload = { cwd: strict.root, hook_event_name: 'PreToolUse', tool_name: 'mcp__postgres__query', tool_input: { sql: 'DELETE FROM users' } };
    const r = runGuard(strict.guard, 'claude', payload, strict.root);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/never allowed/);
  });

  it('unknown agent argument blocks', () => {
    const r = runGuard(strict.guard, 'nonsense', samplePayload('claude', 'shell', 'git status', strict.root), strict.root);
    expect(r.code).toBe(2);
  });
});

describe('normalize and render units', () => {
  it('maps Claude tools', () => {
    const calls = normalize('claude', { tool_name: 'Edit', tool_input: { file_path: '/p/a.ts' }, cwd: '/p' }, { root: '/p' });
    expect(calls[0]).toMatchObject({ kind: 'edit', paths: ['/p/a.ts'] });
    expect(normalize('claude', { tool_name: 'Mystery', tool_input: {} }, { root: '/p' })[0]?.kind).toBe('other');
  });

  it('rejects shell calls without a command and writes without a path', () => {
    expect(() => normalize('claude', { tool_name: 'Bash', tool_input: {} }, { root: '/p' })).toThrow();
    expect(() => normalize('claude', { tool_name: 'Write', tool_input: {} }, { root: '/p' })).toThrow();
  });

  it('converts ask to deny for agents that cannot ask', () => {
    const call = normalize('windsurf', { agent_action_name: 'pre_run_command', tool_info: { command_line: 'npm test' } }, { root: '/p' })[0];
    const out = render('windsurf', call, { decision: 'ask', guard: 'commands', message: 'm', explicit: false, grantable: true });
    expect(out.code).toBe(2);
  });

  it('writes a readable hint for hard rules', () => {
    const call = normalize('claude', { tool_name: 'Bash', tool_input: { command: 'cat .env' } }, { root: '/p' })[0];
    const out = render('claude', call, { decision: 'deny', guard: 'secrets', message: 'm', explicit: false, grantable: false });
    expect(out.stderr).toMatch(/cannot be approved/);
  });
});

describe('integrity', () => {
  it('denies everything after the guard or policy is tampered with', () => {
    const p = installProject('strict');
    try {
      const policy = path.join(p.root, '.ai-guardrules', 'policy.json');
      fs.chmodSync(policy, 0o644);
      fs.writeFileSync(policy, fs.readFileSync(policy, 'utf8').replace('"commands": "ask"', '"commands": "off"'));
      const r = runGuard(p.guard, 'claude', samplePayload('claude', 'shell', 'git status', p.root), p.root);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/integrity|changed outside/);
    } finally {
      p.cleanup();
    }
  });

  it('denies everything when lock.json is deleted', () => {
    const p = installProject('strict');
    try {
      fs.chmodSync(path.join(p.root, '.ai-guardrules', 'lock.json'), 0o644);
      fs.rmSync(path.join(p.root, '.ai-guardrules', 'lock.json'));
      expect(runGuard(p.guard, 'claude', samplePayload('claude', 'read', path.join(p.root, 'src/a.ts'), p.root), p.root).code).toBe(2);
    } finally {
      p.cleanup();
    }
  });

  it('denies when an unlocked custom file appears', () => {
    const p = installProject('strict');
    try {
      fs.mkdirSync(path.join(p.root, '.ai-guardrules', 'custom'), { recursive: true });
      fs.writeFileSync(path.join(p.root, '.ai-guardrules', 'custom', 'guards.json'), '{"guards":[]}');
      expect(runGuard(p.guard, 'claude', samplePayload('claude', 'shell', 'git status', p.root), p.root).code).toBe(2);
    } finally {
      p.cleanup();
    }
  });

  it('survives CRLF conversion of the guard files (git autocrlf)', () => {
    const p = installProject('strict');
    try {
      for (const f of ['policy.json', 'guard.mjs']) {
        const file = path.join(p.root, '.ai-guardrules', f);
        fs.chmodSync(file, 0o644);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n'));
      }
      const r = runGuard(p.guard, 'claude', samplePayload('claude', 'shell', 'git status', p.root), p.root);
      expect(r.code).toBe(0);
    } finally {
      p.cleanup();
    }
  });
});
