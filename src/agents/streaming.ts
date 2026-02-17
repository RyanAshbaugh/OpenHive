/**
 * Live-streaming agent dispatch.
 *
 * Unlike `runAgent()` which buffers all output, `streamAgent()` writes
 * parsed output to a writable stream in real time — ideal for interactive
 * commands like `openhive do` and `openhive chat`.
 */

import type { Writable } from 'node:stream';
import type { AgentAdapter, AgentRunOptions, AgentRunResult } from './adapter.js';
import { LineParser } from './subprocess.js';
import { logger } from '../utils/logger.js';

export interface StreamAgentOptions {
  adapter: AgentAdapter;
  runOptions: AgentRunOptions;
  /** Writable stream to receive parsed output (e.g. process.stdout) */
  output: Writable;
  /** Optional callback for each chunk of parsed text */
  onChunk?: (text: string) => void;
}

/**
 * Spawn an agent and stream parsed output in real time.
 *
 * Returns the same `AgentRunResult` as `runAgent()` but writes parsed
 * text to `options.output` as it arrives rather than buffering.
 */
export function streamAgent(options: StreamAgentOptions): { promise: Promise<AgentRunResult>; kill: () => void } {
  const { adapter, runOptions, output, onChunk } = options;
  const { command, args } = adapter.buildCommand(runOptions);

  logger.debug(`streamAgent: spawning ${command} ${args.slice(0, 3).join(' ')}...`);

  const child = adapter.spawn(runOptions);
  let stdout = '';
  let stderr = '';
  const start = Date.now();

  // Use the adapter's stream parser if it has streaming capability
  const streamParser = runOptions.streamParser;
  const lineParser = streamParser ? new LineParser(streamParser) : null;

  child.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString();

    if (lineParser) {
      const parsed = lineParser.feed(chunk);
      if (parsed) {
        stdout += parsed;
        output.write(parsed);
        onChunk?.(parsed);
      }
    } else {
      stdout += chunk;
      output.write(chunk);
      onChunk?.(chunk);
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    stderr += chunk;
    // Surface stderr to the output stream so the user sees errors
    output.write(chunk);
  });

  const timer = runOptions.timeout
    ? setTimeout(() => {
        logger.warn(`streamAgent: timed out after ${runOptions.timeout}ms, killing`);
        child.kill('SIGTERM');
      }, runOptions.timeout)
    : null;

  const promise = new Promise<AgentRunResult>((resolve) => {
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (lineParser) {
        const remaining = lineParser.flush();
        if (remaining) {
          stdout += remaining;
          output.write(remaining);
          onChunk?.(remaining);
        }
      }
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

  const kill = () => {
    child.kill('SIGTERM');
  };

  return { promise, kill };
}
