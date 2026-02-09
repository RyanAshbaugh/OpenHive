import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import type { AgentRunOptions, AgentRunResult, StreamParser } from './adapter.js';
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

/**
 * Buffers incoming data into complete lines and passes each to a parser.
 * Returns parsed text for both the log file and the stdout accumulator.
 */
class LineParser {
  private buffer = '';

  constructor(private parser: StreamParser) {}

  /** Feed a chunk, returns parsed text (may be empty if no complete lines yet) */
  feed(chunk: string): string {
    this.buffer += chunk;
    let result = '';
    let newlineIdx: number;

    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      const parsed = this.parser(line);
      if (parsed !== null) {
        result += parsed;
      }
    }

    return result;
  }

  /** Flush any remaining partial line */
  flush(): string {
    const line = this.buffer.trim();
    this.buffer = '';
    if (line.length === 0) return '';
    const parsed = this.parser(line);
    return parsed ?? '';
  }
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

    const lineParser = options.streamParser ? new LineParser(options.streamParser) : null;

    child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();

      if (lineParser) {
        // Streaming JSONL mode: parse lines, accumulate and log parsed text
        const parsed = lineParser.feed(chunk);
        if (parsed) {
          stdout += parsed;
          logStream?.write(parsed);
        }
      } else {
        // Plain text mode: accumulate and log raw data
        stdout += chunk;
        logStream?.write(data);
      }
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
      // Flush any remaining buffered content
      if (lineParser) {
        const remaining = lineParser.flush();
        if (remaining) {
          stdout += remaining;
          logStream?.write(remaining);
        }
      }
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
