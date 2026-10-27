import fs from 'node:fs';
import path from 'node:path';
import { decide, type DecideCtx } from './decide.js';
import { loadCustomGuards, loadCustomHooks, runCustomHooks } from './custom.js';
import { consumeGrants, loadGrants } from './grants.js';
import { verifyLock } from './integrity.js';
import { normalize, render, renderFailure, type AgentId, type Outcome, type Output } from './normalize.js';
import { defaultEnv, type PathEnv } from './paths.js';
import { validatePolicy } from './policy.js';
import { RANK, type Call, type Grant, type Verdict } from './types.js';

export interface EvalOptions {
  now?: number;
  env?: PathEnv;
  /** Skip custom hooks (used by unit tests of the core engine). */
  skipHooks?: boolean;
}

export interface EvalResult extends Output {
  outcome: Outcome;
  call?: Call;
}

function toOutcome(v: Verdict): Outcome {
  return { decision: v.decision, guard: v.guard, message: v.message, explicit: v.explicit === true, grantable: v.grantable === true, grantKind: v.grantKind };
}

/** Evaluate one hook payload. Throws on any internal problem; callers must fail closed. */
export function evaluate(agent: AgentId, payload: unknown, dir: string, opts: EvalOptions = {}): EvalResult {
  const root = fs.realpathSync(path.dirname(dir));

  const lock = verifyLock(dir);
  if (!lock.ok) {
    const outcome: Outcome = {
      decision: 'deny',
      guard: 'integrity',
      message: `The guardrail files were changed outside ai-rules (${lock.problems.join('; ')}). Everything is blocked until the user runs "ai-rules lock" or "ai-rules update".`,
      explicit: false,
      grantable: false,
    };
    return { ...render(agent, undefined, outcome), outcome };
  }

  const policy = validatePolicy(JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8')));
  const ctx: DecideCtx = {
    root,
    policy,
    env: opts.env ?? defaultEnv(root),
    grants: loadGrants(dir),
    customGuards: loadCustomGuards(dir),
    now: opts.now,
  };
  const hooks = opts.skipHooks ? [] : loadCustomHooks(dir);

  const calls = normalize(agent, payload, { root });
  if (calls.length === 0) {
    const outcome: Outcome = { decision: 'allow', guard: 'none', message: '', explicit: false, grantable: false };
    return { ...render(agent, undefined, outcome), outcome };
  }

  let worst: { verdict: Verdict; call: Call } | null = null;
  const used: Grant[] = [];
  for (const call of calls) {
    const r = decide(call, ctx);
    used.push(...r.usedGrants);
    if (!worst || RANK[r.verdict.decision] > RANK[worst.verdict.decision]) worst = { verdict: r.verdict, call };
  }
  if (!worst) throw new Error('no verdict produced');

  if (worst.verdict.decision !== 'deny' && hooks.length) {
    for (const call of calls) {
      for (const h of runCustomHooks(hooks, call, root)) {
        const v: Verdict = { decision: h.decision, guard: h.guard, message: h.message, grantable: false };
        if (RANK[v.decision] > RANK[worst.verdict.decision]) worst = { verdict: v, call };
      }
    }
  }

  const outcome = toOutcome(worst.verdict);
  if (outcome.decision === 'allow' && used.length) consumeGrants(dir, used, ctx.now);
  return { ...render(agent, worst.call, outcome), outcome, call: worst.call };
}

/** Never throws: any failure becomes a block. */
export function evaluateSafe(agent: AgentId | undefined, payload: unknown, dir: string, opts: EvalOptions = {}): EvalResult {
  try {
    if (!agent) throw new Error('unknown agent argument');
    return evaluate(agent, payload, dir, opts);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...renderFailure(agent, message), outcome: { decision: 'deny', guard: 'error', message, explicit: false, grantable: false } };
  }
}
