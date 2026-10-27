import pc from 'picocolors';

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
}

export const out = {
  line: (s = ''): void => {
    process.stdout.write(s + '\n');
  },
  heading: (s: string): void => out.line('\n' + pc.bold(s)),
  ok: (s: string): void => out.line(`${pc.green('ok')}    ${s}`),
  warn: (s: string): void => out.line(`${pc.yellow('warn')}  ${s}`),
  fail: (s: string): void => out.line(`${pc.red('fail')}  ${s}`),
  info: (s: string): void => out.line(`${pc.cyan('info')}  ${s}`),
  dim: (s: string): void => out.line(pc.dim(s)),
};

export { pc };

export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = (rows[0] as string[]).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] as number))).join('  ')).join('\n');
}
