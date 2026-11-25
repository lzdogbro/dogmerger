import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type PickerKind = 'open' | 'save' | 'directory';

export interface PickerOptions {
  kind: PickerKind;
  /** Dialog title. */
  prompt: string;
  /** Default file name for save dialogs. */
  defaultName?: string;
  /** Directory the dialog opens in. */
  startIn?: string;
}

class PickerCanceled extends Error {
  constructor() {
    super('canceled');
    this.name = 'PickerCanceled';
  }
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function run(cmd: string, args: string[]): Promise<string> {
  return execFileAsync(cmd, args, { timeout: 10 * 60_000, maxBuffer: 1 << 20 }).then(
    (result) => result.stdout.trim(),
  );
}

async function pickMac(options: PickerOptions): Promise<string> {
  let expression: string;
  if (options.kind === 'directory') {
    expression = `POSIX path of (choose folder with prompt ${appleScriptString(options.prompt)})`;
  } else if (options.kind === 'save') {
    const defaultName = appleScriptString(options.defaultName ?? 'output.mp4');
    expression =
      `POSIX path of (choose file name with prompt ${appleScriptString(options.prompt)} ` +
      `default name ${defaultName})`;
  } else {
    expression = `POSIX path of (choose file with prompt ${appleScriptString(options.prompt)})`;
  }
  try {
    return await run('osascript', ['-e', expression]);
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? '');
    if (stderr.includes('-128') || stderr.toLowerCase().includes('canceled')) {
      throw new PickerCanceled();
    }
    throw error;
  }
}

async function pickLinux(options: PickerOptions): Promise<string> {
  const args: string[] = ['--file-selection'];
  if (options.kind === 'directory') args.push('--directory');
  if (options.kind === 'save') args.push('--save', '--confirm-overwrite');
  args.push(`--title=${options.prompt}`);
  if (options.startIn) args.push(`--filename=${options.startIn.replace(/\/?$/, '/')}`);
  try {
    return await run('zenity', args);
  } catch (error) {
    const code = (error as { code?: number }).code;
    // zenity returns 1 when the user cancels.
    if (code === 1) throw new PickerCanceled();
    throw error;
  }
}

const POWERSHELL_OPEN = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:DOGMERGER_PROMPT
if ($env:DOGMERGER_START) { $dialog.InitialDirectory = $env:DOGMERGER_START }
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }
`;

const POWERSHELL_SAVE = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.SaveFileDialog
$dialog.Title = $env:DOGMERGER_PROMPT
$dialog.FileName = $env:DOGMERGER_NAME
if ($env:DOGMERGER_START) { $dialog.InitialDirectory = $env:DOGMERGER_START }
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }
`;

const POWERSHELL_FOLDER = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = $env:DOGMERGER_PROMPT
if ($env:DOGMERGER_START) { $dialog.SelectedPath = $env:DOGMERGER_START }
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }
`;

async function pickWindows(options: PickerOptions): Promise<string> {
  const script =
    options.kind === 'save'
      ? POWERSHELL_SAVE
      : options.kind === 'directory'
        ? POWERSHELL_FOLDER
        : POWERSHELL_OPEN;

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', script],
    {
      timeout: 10 * 60_000,
      maxBuffer: 1 << 20,
      env: {
        ...process.env,
        DOGMERGER_PROMPT: options.prompt,
        DOGMERGER_START: options.startIn ?? '',
        DOGMERGER_NAME: options.defaultName ?? 'output.mp4',
      },
    },
  );
  const picked = stdout.trim();
  if (!picked) throw new PickerCanceled();
  return picked;
}

/**
 * Opens the OS native picker. Returns an absolute path, or null when the user
 * cancels. Running the dialog on the server side is what lets the browser hand
 * over a real filesystem path instead of uploading gigabytes over HTTP.
 */
export async function pickPath(options: PickerOptions): Promise<string | null> {
  try {
    if (process.platform === 'darwin') return await pickMac(options);
    if (process.platform === 'win32') return await pickWindows(options);
    return await pickLinux(options);
  } catch (error) {
    if (error instanceof PickerCanceled) return null;
    throw error;
  }
}

export function pickerUnsupportedReason(): string | null {
  if (process.platform === 'darwin' || process.platform === 'win32') return null;
  if (process.platform === 'linux') {
    return 'Linux 下需要安装 zenity 才能使用原生选择框；也可以直接手动输入路径。';
  }
  return '当前平台不支持原生选择框，请手动输入路径。';
}
