import { runDoctor, summarize } from '../core/doctor.js';
import { out, pc } from '../ui.js';

export function runDoctorCommand(root: string, o: { ci?: boolean }): void {
  const checks = runDoctor(root);
  let group = '';
  for (const c of checks) {
    if (c.group !== group) {
      group = c.group;
      out.heading(group);
    }
    const detail = c.detail ? pc.dim(` - ${c.detail}`) : '';
    if (c.ok) out.ok(c.label);
    else if (c.critical) out.fail(c.label + detail);
    else out.warn(c.label + detail);
  }
  const { failed, warned } = summarize(checks);
  out.line('');
  if (failed === 0) out.line(pc.green(`All critical checks passed${warned ? `, ${warned} warning${warned > 1 ? 's' : ''}` : ''}.`));
  else out.line(pc.red(`${failed} critical problem${failed > 1 ? 's' : ''} found.`));
  // --ci and interactive runs both exit non-zero on a critical problem; --ci only documents the intent.
  void o;
  if (failed > 0) process.exitCode = 1;
}
