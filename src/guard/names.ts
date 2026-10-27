/** Command-name sets (lowercase, no extension). Covers POSIX tools, PowerShell cmdlets/aliases and cmd builtins. */

const s = (...xs: string[]): Set<string> => new Set(xs);

export const DELETE_CMDS = s(
  'rm', 'rmdir', 'unlink', 'shred', 'srm', 'wipe', 'trash', 'trash-put', 'trash-cli', 'gio-trash', 'rimraf', 'truncate',
  'del', 'erase', 'rd', 'ri', 'remove-item', 'remove-itemproperty', 'clear-content', 'clc',
);

export const MOVE_CMDS = s('mv', 'move', 'mi', 'move-item', 'ren', 'rename', 'rni', 'rename-item');
export const COPY_CMDS = s('cp', 'copy', 'cpi', 'copy-item', 'xcopy', 'robocopy', 'install', 'rsync');
export const CREATE_CMDS = s('touch', 'mkdir', 'md', 'ni', 'new-item', 'tee', 'set-content', 'sc', 'out-file', 'add-content', 'ac', 'mkfifo', 'mknod', 'mktemp');
export const LINK_CMDS = s('ln', 'mklink', 'link');

export const SHELL_NAMES = s('sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'csh', 'tcsh', 'mksh', 'cmd', 'powershell', 'pwsh', 'iex', 'invoke-expression');
export const INTERPRETERS = s('python', 'node', 'bun', 'deno', 'perl', 'ruby', 'php', 'lua', 'osascript', 'rscript', 'julia');
export const DOWNLOADERS = s('curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'fetch', 'nc', 'ncat', 'netcat', 'base64', 'certutil', 'bitsadmin');

export const DISK_CMDS = s('mkfs', 'mke2fs', 'mkswap', 'fdisk', 'parted', 'wipefs', 'diskpart', 'format', 'format-volume', 'clear-disk', 'initialize-disk', 'diskutil');
export const POWER_CMDS = s('shutdown', 'reboot', 'halt', 'poweroff', 'restart-computer', 'stop-computer');

/** Launchers whose payload cannot be analysed. */
export const OPAQUE_LAUNCHERS = s('start-process', 'saps', 'start-job', 'invoke-item', 'ii', 'rundll32', 'mshta', 'wscript', 'cscript', 'regsvr32', 'at', 'schtasks', 'crontab');

export const CD_CMDS = s('cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location');

/** Commands that only read files; mentioning a protected path with them is fine. */
export const READ_ONLY_CMDS = s(
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ls', 'dir', 'wc', 'stat', 'file', 'type',
  'get-content', 'gc', 'select-string', 'sls', 'diff', 'bat', 'nl', 'tree', 'find', 'get-childitem', 'gci', 'get-item', 'gi',
  'sha256sum', 'md5sum', 'shasum', 'test', '[', 'realpath', 'readlink', 'basename', 'dirname', 'pwd', 'echo', 'printf', 'cd', 'chdir',
  'set-location', 'sl', 'push-location', 'pushd', 'get-filehash', 'test-path', 'resolve-path', 'where', 'which', 'get-command',
);

/** Commands whose arguments are free text rather than paths. */
export const TEXT_CMDS = s('echo', 'printf', 'test', '[', '[[', 'true', 'false', ':', 'export', 'set', 'read', 'unset', 'declare', 'local', 'readonly', 'alias', 'sleep', 'expr', 'let', 'return', 'exit', 'shift', 'wait', 'write-host', 'write-output', 'write-error', 'start-sleep', 'rem', 'title', 'color');

export const READ_ENV_CMDS = s('printenv', 'env');

/** `-r`, `-rf`, `--recursive`, `/s`, `-Recurse`. Long single-dash words such as `-Force` do not count. */
export function isRecursiveFlag(a: string): boolean {
  if (/^(--recursive|\/s|-recurse)$/i.test(a)) return true;
  return /^-[a-zA-Z]{1,4}$/.test(a) && /[rR]/.test(a);
}
