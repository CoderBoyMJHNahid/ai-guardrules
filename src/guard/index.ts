/**
 * ai-guardrules guard: copied to `<project>/.ai-guardrules/guard.mjs` and called by each agent's hook.
 * Usage: node .ai-guardrules/guard.mjs <agent>   (hook payload on stdin)
 * Any failure blocks the action.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateSafe } from './evaluate.js';
import { isAgent, renderFailure, type AgentId, type Output } from './normalize.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
function parseAgentArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--tool=')) return a.slice(7);
    if (a === '--tool') return argv[i + 1];
    if (a === '--version') return a;
  }
  return argv[0];
}
const agentArg = parseAgentArg(process.argv.slice(2));
const agent: AgentId | undefined = isAgent(agentArg) ? agentArg : undefined;

function emit(o: Output): void {
  if (o.stdout) process.stdout.write(o.stdout);
  if (o.stderr) process.stderr.write(o.stderr);
  process.exitCode = o.code;
}

function fail(message: string): void {
  emit(renderFailure(agent, message));
}

process.on('uncaughtException', (e) => {
  fail(e instanceof Error ? e.message : String(e));
  process.exit(2);
});
process.on('unhandledRejection', (e) => {
  fail(e instanceof Error ? e.message : String(e));
  process.exit(2);
});

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  if (agentArg === '--version') {
    process.stdout.write('ai-guardrules guard\n');
    return;
  }
  const timer = setTimeout(() => {
    fail('timed out waiting for the hook payload');
    process.exit(2);
  }, 15_000);
  const raw = await readStdin();
  clearTimeout(timer);
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail('the hook payload is not valid JSON');
    return;
  }
  emit(evaluateSafe(agent, payload, dir));
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
