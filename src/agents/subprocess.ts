import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import type { AgentRunOptions, AgentRunResult } from './adapter.js';
import { logger } from '../utils/logger.js';

export function spawnAgent(
  command: string,
  args: string[],
  options: AgentRunOptions,
): ChildProcess {
  logger.debug(`Spawning: ${command} ${args.join(' ')} in ${options.cwd}`);
  return spawn(command, args, {
    cwd: options.cwd,
    stdio: 'pipe',
    env: { ...process.env },
  });
}

export function runAgent(
  command: string,
  args: string[],
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawnAgent(command, args, options);
    let stdout = '';
    let stderr = '';

    let logStream: WriteStream | null = null;
    if (options.logFile) {
      logStream = createWriteStream(options.logFile, { flags: 'a' });
    }

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
      logStream?.write(data);
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
      logStream?.write(data);
    });

    const timer = options.timeout
      ? setTimeout(() => {
          logger.warn(`Agent timed out after ${options.timeout}ms, killing`);
          child.kill('SIGTERM');
        }, options.timeout)
      : null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      logStream?.end();
    };

    child.on('close', (code) => {
      cleanup();
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });

    child.on('error', (err) => {
      cleanup();
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + '\n' + err.message,
        durationMs: Date.now() - start,
      });
    });
  });
}
