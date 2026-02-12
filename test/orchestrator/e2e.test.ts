/**
 * End-to-end test for the orchestrator.
 *
 * Uses a real tmux session with a mock "agent" (a bash script that mimics
 * an interactive CLI tool). Validates the full lifecycle:
 *   1. tmux session creation
 *   2. Window creation with the mock agent
 *   3. Ready detection (prompt)
 *   4. Task dispatch (sending prompt text)
 *   5. State detection (working → idle)
 *   6. Task completion detection
 *   7. Graceful shutdown
 *
 * Requires tmux to be installed. Skipped in CI if tmux is not available.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureSession,
  killSession,
  createWindow,
  killWindow,
  capturePane,
  sendText,
  stripAnsi,
  sleep,
  ORCHESTRATOR_SESSION,
  waitForReady,
  startPipePane,
  getFileSize,
} from '../../src/orchestrator/tmux.js';

const execFileAsync = promisify(execFile);

// Check if tmux is available
let tmuxAvailable = false;
try {
  await execFileAsync('tmux', ['-V']);
  tmuxAvailable = true;
} catch {
  // tmux not installed
}

// Helper to create the mock agent script
async function createMockAgent(scriptDir: string): Promise<string> {
  await mkdir(scriptDir, { recursive: true });
  const scriptPath = join(scriptDir, 'mock-agent.sh');

  // A simple script that mimics an interactive agent:
  // - Shows a ">" prompt
  // - Reads input
  // - If input is "exit", quits
  // - Otherwise, prints "Working..." with a brief delay, then shows prompt again
  const script = `#!/bin/bash
echo "Mock Agent v1.0"
echo ""
while true; do
  printf "> "
  read -r input
  if [ -z "$input" ]; then
    continue
  fi
  if [ "$input" = "exit" ]; then
    echo "Goodbye"
    exit 0
  fi
  echo "Working on: $input"
  sleep 1
  echo "Done!"
  echo ""
done
`;

  await writeFile(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

describe.skipIf(!tmuxAvailable)('Orchestrator E2E (requires tmux)', () => {
  const testDir = join(tmpdir(), `openhive-e2e-${Date.now()}`);
  let mockAgentPath: string;

  beforeAll(async () => {
    mockAgentPath = await createMockAgent(testDir);
  });

  afterEach(async () => {
    // Clean up any test session
    try {
      await killSession();
    } catch {
      // ignore
    }
    // Reset the sessionReady cache by calling killSession (which sets it to false)
  });

  afterAll(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('creates and manages a tmux session', async () => {
    await ensureSession();

    // Verify session exists
    const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}']);
    expect(stdout).toContain(ORCHESTRATOR_SESSION);
  });

  it('creates a window with a command and captures output', async () => {
    await ensureSession();
    const target = await createWindow('e2e-test', `bash ${mockAgentPath}`);

    expect(target).toBe(`${ORCHESTRATOR_SESSION}:e2e-test`);

    // Wait for the mock agent to start and show its prompt
    await sleep(1500);

    const raw = await capturePane(target);
    const output = stripAnsi(raw);

    expect(output).toContain('Mock Agent v1.0');
    expect(output).toContain('>');
  });

  it('sends text and sees agent output', async () => {
    await ensureSession();
    const target = await createWindow('e2e-send', `bash ${mockAgentPath}`);
    await sleep(1500);

    // Send a prompt
    await sendText(target, 'Build a button component');
    await sleep(2500); // Wait for the script to process (1s sleep in script)

    const raw = await capturePane(target);
    const output = stripAnsi(raw);

    expect(output).toContain('Working on: Build a button component');
    expect(output).toContain('Done!');
    // Should be back at prompt
    expect(output).toMatch(/>\s*$/m);
  });

  it('waitForReady detects the prompt', async () => {
    await ensureSession();
    const target = await createWindow('e2e-ready', `bash ${mockAgentPath}`);

    const output = await waitForReady(
      target,
      />\s*$/m, // Same pattern as Claude's readyPattern
      undefined,
      { maxWaitMs: 10_000, pollMs: 500 },
    );

    expect(output).toContain('>');
  });

  it('pipe-pane captures output to a file', async () => {
    await ensureSession();
    const target = await createWindow('e2e-pipe', `bash ${mockAgentPath}`);
    const pipeFile = join(testDir, 'e2e-pipe.log');
    await writeFile(pipeFile, '', 'utf-8');

    await startPipePane(target, pipeFile);
    await sleep(1500);

    // Send some text
    await sendText(target, 'Test pipe output');
    await sleep(2500);

    // Check pipe file has content
    const size = await getFileSize(pipeFile);
    expect(size).toBeGreaterThan(0);
  });

  it('full lifecycle: start → send prompt → detect working → detect idle → done', async () => {
    await ensureSession();
    const target = await createWindow('e2e-lifecycle', `bash ${mockAgentPath}`);

    // 1. Wait for ready
    const readyOutput = await waitForReady(
      target,
      />\s*$/m,
      undefined,
      { maxWaitMs: 10_000, pollMs: 500 },
    );
    expect(readyOutput).toContain('>');

    // 2. Send a task prompt
    await sendText(target, 'Create a REST API');

    // 3. Briefly after sending, the agent should be "working"
    await sleep(500);
    const workingRaw = await capturePane(target);
    const workingOutput = stripAnsi(workingRaw);
    expect(workingOutput).toContain('Working on: Create a REST API');

    // 4. After the agent finishes (1s sleep in script), should be back at prompt
    await sleep(2000);
    const doneRaw = await capturePane(target);
    const doneOutput = stripAnsi(doneRaw);
    expect(doneOutput).toContain('Done!');
    expect(doneOutput).toMatch(/>\s*$/m);

    // 5. Cleanup
    await killWindow(target);
  });

  it('handles session cleanup on shutdown', async () => {
    await ensureSession();

    // Verify session exists
    let { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}']);
    expect(stdout).toContain(ORCHESTRATOR_SESSION);

    // Kill the session
    await killSession();

    // Verify session is gone
    const { stdout: after } = await execFileAsync('tmux', ['list-sessions', '-F', '#{session_name}']).catch(() => ({ stdout: '' }));
    expect(after).not.toContain(ORCHESTRATOR_SESSION);
  });
});
