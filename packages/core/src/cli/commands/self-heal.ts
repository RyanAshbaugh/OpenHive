/**
 * Self-healing test runner.
 *
 * Captures test output on failure, dispatches a fix task to an agent,
 * then retries. Repeats until success or maxRetries is reached.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { Orchestrator } from '../../orchestrator/orchestrator.js';
import { createTask } from '../../tasks/task.js';
import { TaskStorage } from '../../tasks/storage.js';
import { logger } from '../../utils/logger.js';

const DEFAULT_TASK_STORAGE_DIR = join(homedir(), '.openhive', 'tasks');

const execFileAsync = promisify(execFile);

export interface SelfHealOptions {
  /** Test command to run (default: 'npx') */
  command?: string;
  /** Test command args (default: ['vitest', 'run']) */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Agent name to use for fixes (default: 'claude') */
  agent?: string;
  /** Max retries (default: 3) */
  maxRetries?: number;
  /** Timeout per test run in ms (default: 120000) */
  testTimeout?: number;
}

export interface SelfHealResult {
  success: boolean;
  attempts: number;
  lastTestOutput?: string;
  /** Reason the last fix attempt failed (from orchestrator), if any. */
  lastFailReason?: string;
}

/** Max lines to include in a single prompt before truncating. */
const MAX_PROMPT_LINES = 500;

/**
 * Build the fix prompt from captured test output.
 *
 * Includes the full output up to MAX_PROMPT_LINES. If the output was
 * truncated, the prompt tells the agent how many lines were omitted
 * so it can read the full log file if needed.
 */
export function buildFixPrompt(stdout: string, stderr: string): string {
  const combined = (stdout + '\n' + stderr).trim();
  const lines = combined.split('\n');
  const totalLines = lines.length;
  const truncated = totalLines > MAX_PROMPT_LINES;
  const included = truncated ? lines.slice(-MAX_PROMPT_LINES) : lines;

  const header = truncated
    ? `A test failure occurred. Here is the error output (last ${MAX_PROMPT_LINES} of ${totalLines} lines — ${totalLines - MAX_PROMPT_LINES} earlier lines omitted; check the full output if you need more context):`
    : 'A test failure occurred. Here is the full error output:';

  return [
    header,
    '',
    '```',
    included.join('\n'),
    '```',
    '',
    'Fix the code so the tests pass. Do not modify the test files unless the tests themselves are clearly wrong.',
  ].join('\n');
}

/**
 * Run tests with self-healing: on failure, dispatch a fix to an agent and retry.
 */
export async function runWithSelfHealing(
  options: SelfHealOptions = {},
): Promise<SelfHealResult> {
  const {
    command = 'npx',
    args = ['vitest', 'run'],
    cwd = process.cwd(),
    agent: agentName = 'claude',
    maxRetries = 3,
    testTimeout = 120_000,
  } = options;

  let attempts = 0;
  let lastTestOutput: string | undefined;
  let lastFailReason: string | undefined;

  while (attempts <= maxRetries) {
    attempts++;
    logger.info(`Self-heal: test attempt ${attempts}/${maxRetries + 1}`);

    // Run the test command
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      const result = await execFileAsync(command, args, {
        cwd,
        timeout: testTimeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      stdout = execErr.stdout ?? '';
      stderr = execErr.stderr ?? '';
      exitCode = execErr.code ?? 1;
    }

    lastTestOutput = stdout + '\n' + stderr;

    // Success — done
    if (exitCode === 0) {
      logger.info(`Self-heal: tests passed on attempt ${attempts}`);
      return { success: true, attempts, lastTestOutput };
    }

    logger.warn(`Self-heal: tests failed on attempt ${attempts} (exit ${exitCode})`);

    // If we've exhausted retries, don't dispatch another fix
    if (attempts > maxRetries) {
      break;
    }

    // Dispatch fix to agent via orchestrator
    const prompt = buildFixPrompt(stdout, stderr);
    logger.info(`Self-heal: dispatching fix to ${agentName} via orchestrator...`);

    const taskStorage = new TaskStorage(DEFAULT_TASK_STORAGE_DIR);
    const orchestrator = new Orchestrator({
      config: {
        maxWorkers: 1,
        autoApprove: true,
        tickIntervalMs: 2000,
        useWorktrees: false,     // Fix in-place — agent edits same dir tests run in
        repoRoot: cwd,
        stuckTimeoutMs: 180_000, // 3 min
        taskTimeoutMs: 300_000,  // 5 min per fix attempt
      },
      taskStorage,
      onEvent: (e) => logger.info(`Self-heal [${e.type}]`),
    });

    const task = createTask(prompt, `selfheal-${attempts}`, { agent: agentName });
    orchestrator.queueTask(task);
    await orchestrator.start();

    const taskSucceeded = orchestrator.isTaskCompleted(task.id);
    lastFailReason = orchestrator.getFailureReason(task.id);
    await orchestrator.shutdown();

    if (!taskSucceeded) {
      logger.warn(`Self-heal: agent fix failed${lastFailReason ? `: ${lastFailReason}` : ''}`);
    }
  }

  return {
    success: false,
    attempts,
    lastTestOutput,
    lastFailReason,
  };
}
