import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { streamAgent } from '../../src/agents/streaming.js';
import type { AgentAdapter, AgentRunOptions, AgentRunResult } from '../../src/agents/adapter.js';

/**
 * Create a minimal mock adapter that spawns a real process.
 * The `spawn` method delegates to the given factory so each test
 * can control what subprocess is created.
 */
function makeMockAdapter(spawnFn: (opts: AgentRunOptions) => ReturnType<typeof spawn>): AgentAdapter {
  return {
    name: 'test-echo',
    displayName: 'Test Echo',
    provider: 'test',
    command: 'echo',
    supportedModes: ['pipe'],
    capabilities: { vision: false, streaming: false, headless: true },
    checkAvailability: async () => true,
    buildCommand: () => ({ command: 'echo', args: ['hello world'] }),
    spawn: spawnFn,
    run: async () => ({ exitCode: 0, stdout: '', stderr: '', durationMs: 0 }),
  };
}

const baseRunOptions: AgentRunOptions = {
  prompt: 'test',
  cwd: process.cwd(),
};

describe('streamAgent', () => {
  it('should write output to the writable stream', async () => {
    const adapter = makeMockAdapter(() => spawn('echo', ['hello world']));
    const output = new PassThrough();

    const { promise } = streamAgent({
      adapter,
      runOptions: baseRunOptions,
      output,
    });

    const result = await promise;

    // Collect everything that was written to the PassThrough
    const chunks: Buffer[] = [];
    output.on('data', (chunk: Buffer) => chunks.push(chunk));
    output.end();

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello world');
  });

  it('should call onChunk for each chunk of output', async () => {
    const adapter = makeMockAdapter(() => spawn('echo', ['hello world']));
    const output = new PassThrough();
    const onChunk = vi.fn();

    const { promise } = streamAgent({
      adapter,
      runOptions: baseRunOptions,
      output,
      onChunk,
    });

    await promise;

    expect(onChunk).toHaveBeenCalled();
    const allText = onChunk.mock.calls.map((c) => c[0]).join('');
    expect(allText).toContain('hello world');
  });

  it('should terminate the process when kill is called', async () => {
    // Use `sleep` so the process lives long enough to be killed
    const adapter = makeMockAdapter(() => spawn('sleep', ['10']));
    const output = new PassThrough();

    const { promise, kill } = streamAgent({
      adapter,
      runOptions: baseRunOptions,
      output,
    });

    // Give the process a moment to start, then kill it
    await new Promise((r) => setTimeout(r, 50));
    kill();

    const result = await promise;

    // On SIGTERM the exit code is null (resolved as 1) or 143 depending on platform
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });
});
