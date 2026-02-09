import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function exec(command: string, args: string[], options?: {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
}): Promise<ExecResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options?.cwd,
      timeout: options?.timeout,
      env: options?.env ? { ...process.env, ...options.env } : undefined,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
    };
  }
}

export function spawnProcess(command: string, args: string[], options?: {
  cwd?: string;
  env?: Record<string, string>;
  stdio?: 'pipe' | 'inherit';
}): ChildProcess {
  return spawn(command, args, {
    cwd: options?.cwd,
    env: options?.env ? { ...process.env, ...options.env } : undefined,
    stdio: options?.stdio ?? 'pipe',
  });
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    const result = await exec('which', [command]);
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
