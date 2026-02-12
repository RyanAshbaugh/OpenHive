/**
 * Low-level tmux helpers for the orchestrator.
 *
 * Extracted and extended from src/pool/usage-probe.ts. Provides session/window
 * lifecycle management, send-keys, capture-pane, and pipe-pane support.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, open } from 'node:fs/promises';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

// ─── Constants ───────────────────────────────────────────────────────────────

export const ORCHESTRATOR_SESSION = 'openhive-orch';

// ─── Core tmux wrapper ───────────────────────────────────────────────────────

export async function tmux(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('tmux', args, { timeout: 10_000 });
    return stdout;
  } catch (err: any) {
    const stderr = err.stderr ? ` (stderr: ${err.stderr.trim()})` : '';
    throw new Error(`tmux ${args.join(' ')} failed: ${err.message}${stderr}`);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Strip ANSI escape codes from tmux captured output */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

// ─── Session Management ─────────────────────────────────────────────────────

let sessionReady = false;

export async function ensureSession(): Promise<void> {
  if (sessionReady) {
    // Verify session still exists (could have been killed externally)
    try {
      await tmux('has-session', '-t', ORCHESTRATOR_SESSION);
      return;
    } catch {
      sessionReady = false;
      // Fall through to create
    }
  }

  try {
    await tmux('has-session', '-t', ORCHESTRATOR_SESSION);
    sessionReady = true;
  } catch {
    logger.info(`Creating tmux session: ${ORCHESTRATOR_SESSION}`);
    await tmux('new-session', '-d', '-s', ORCHESTRATOR_SESSION, '-x', '220', '-y', '60');
    sessionReady = true;
  }
}

export async function killSession(): Promise<void> {
  sessionReady = false;
  try {
    await tmux('kill-session', '-t', ORCHESTRATOR_SESSION);
  } catch {
    // Session doesn't exist
  }
}

export async function sessionExists(): Promise<boolean> {
  try {
    await tmux('has-session', '-t', ORCHESTRATOR_SESSION);
    return true;
  } catch {
    return false;
  }
}

// ─── Window Management ───────────────────────────────────────────────────────

/**
 * Create a new tmux window running the specified command.
 * Returns the window target (session:window).
 * @param cwd - optional working directory for the new window
 */
export async function createWindow(windowName: string, command: string, cwd?: string): Promise<string> {
  const target = `${ORCHESTRATOR_SESSION}:${windowName}`;

  // Kill existing window if present
  try {
    await tmux('kill-window', '-t', target);
  } catch {
    // Window doesn't exist
  }

  const args = ['new-window', '-t', ORCHESTRATOR_SESSION, '-n', windowName];
  if (cwd) {
    args.push('-c', cwd);
  }
  args.push(command);
  await tmux(...args);
  return target;
}

export async function killWindow(target: string): Promise<void> {
  try {
    await tmux('kill-window', '-t', target);
  } catch {
    // Already dead
  }
}

/**
 * Check if a tmux window/pane is still alive.
 */
export async function isWindowAlive(target: string): Promise<boolean> {
  try {
    await tmux('has-session', '-t', target);
    // has-session checks session, we need to verify the specific window
    const output = await tmux('list-windows', '-t', ORCHESTRATOR_SESSION, '-F', '#{window_name}');
    const windowName = target.split(':')[1];
    return output.split('\n').some(line => line.trim() === windowName);
  } catch {
    return false;
  }
}

// ─── send-keys ───────────────────────────────────────────────────────────────

/**
 * Send keys to a tmux pane. Each element in `keys` is passed as a separate
 * argument to `tmux send-keys`.
 */
export async function sendKeys(target: string, keys: string[]): Promise<void> {
  await tmux('send-keys', '-t', target, ...keys);
}

/**
 * Type text followed by Enter. For sending prompts/responses to agents.
 */
export async function sendText(target: string, text: string): Promise<void> {
  // Use literal flag to avoid interpreting special chars
  await tmux('send-keys', '-t', target, '-l', text);
  // Brief delay to let TUI process the typed text before Enter
  await sleep(500);
  await tmux('send-keys', '-t', target, 'Enter');
}

// ─── capture-pane ────────────────────────────────────────────────────────────

/**
 * Capture the current visible content of a tmux pane.
 * @param target - tmux target (session:window or session:window.pane)
 * @param scrollback - negative number captures last N lines from bottom
 */
export async function capturePane(target: string, scrollback = -60): Promise<string> {
  return tmux('capture-pane', '-t', target, '-p', '-S', String(scrollback));
}

// ─── pipe-pane ───────────────────────────────────────────────────────────────

/**
 * Start streaming all pane output to a file.
 * This is O(1) to check for changes (just stat the file size).
 * The file also serves as the complete worker log.
 */
export async function startPipePane(target: string, outputFile: string): Promise<void> {
  // -o flag: only output (don't pipe input back)
  await tmux('pipe-pane', '-t', target, '-o', `cat >> ${outputFile}`);
  logger.debug(`pipe-pane started: ${target} → ${outputFile}`);
}

/**
 * Stop pipe-pane for a target.
 */
export async function stopPipePane(target: string): Promise<void> {
  try {
    // Calling pipe-pane with no command stops the pipe
    await tmux('pipe-pane', '-t', target);
  } catch {
    // Already stopped or window dead
  }
}

/**
 * Get the current size of a file. Returns 0 if file doesn't exist.
 * This is the O(1) check for new output from pipe-pane.
 */
export async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await stat(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

// ─── Pipe file reading ───────────────────────────────────────────────────────

/**
 * Read the last N lines from a pipe file without loading the entire file.
 * Reads backwards from the end of the file in chunks until enough lines found.
 * Returns ANSI-stripped text.
 */
export async function readPipeTail(filePath: string, lines: number): Promise<string> {
  let fh;
  try {
    fh = await open(filePath, 'r');
    const stats = await fh.stat();
    if (stats.size === 0) return '';

    // Read from end in chunks — 8KB per chunk is enough for ~200 lines
    const chunkSize = 8192;
    let position = Math.max(0, stats.size - chunkSize);
    let collected = '';

    // Read up to 4 chunks (32KB) max — sufficient for any reasonable context
    for (let i = 0; i < 4; i++) {
      const readSize = Math.min(chunkSize, stats.size - position);
      const buf = Buffer.alloc(readSize);
      await fh.read(buf, 0, readSize, position);
      collected = buf.toString('utf-8') + collected;

      const lineCount = collected.split('\n').length - 1;
      if (lineCount >= lines || position === 0) break;

      position = Math.max(0, position - chunkSize);
    }

    // Take last N lines
    const allLines = collected.split('\n');
    const tail = allLines.slice(-lines).join('\n');
    return stripAnsi(tail);
  } catch {
    return '';
  } finally {
    await fh?.close();
  }
}

// ─── Readiness detection ─────────────────────────────────────────────────────

/**
 * Wait for a tool's TUI to be ready for input.
 * Polls capture-pane looking for readyPattern. Dismisses startup dialogs.
 */
export async function waitForReady(
  target: string,
  readyPattern: RegExp,
  startupDialogPattern?: RegExp,
  options?: { maxWaitMs?: number; pollMs?: number },
): Promise<string> {
  const maxWaitMs = options?.maxWaitMs ?? 15_000;
  const pollMs = options?.pollMs ?? 1000;
  const maxAttempts = Math.ceil(maxWaitMs / pollMs);

  // Initial delay for tool to start rendering
  await sleep(2000);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const raw = await capturePane(target);
    const output = stripAnsi(raw);

    // Check startup dialog BEFORE readyPattern — dialogs can contain
    // prompt characters (like ❯) that would false-match the ready pattern.
    // Only check the last few lines so dismissed dialogs in scrollback
    // don't keep matching forever.
    const tailLines = output.split('\n').filter(l => l.trim()).slice(-5).join('\n');
    if (startupDialogPattern && startupDialogPattern.test(tailLines)) {
      logger.info('Startup dialog detected, sending Enter to dismiss');
      await sendKeys(target, ['Enter']);
      await sleep(2000);
      continue;
    }

    if (readyPattern.test(output)) {
      logger.info(`Tool ready after ${attempt + 1} polls`);
      return output;
    }

    // Log progress every few attempts so the user can see what's happening
    if (attempt > 0 && attempt % 3 === 0) {
      const lastLine = output.split('\n').filter(l => l.trim()).pop() ?? '(empty)';
      logger.info(
        `Waiting for tool ready (${attempt + 1}/${maxAttempts})... last line: ${lastLine.slice(0, 80)}`,
      );
    }

    await sleep(pollMs);
  }

  const finalOutput = stripAnsi(await capturePane(target));
  const lastLine = finalOutput.split('\n').filter(l => l.trim()).pop() ?? '(empty)';
  logger.warn(`Readiness timeout after ${maxWaitMs}ms. Last line: ${lastLine.slice(0, 80)}`);
  return finalOutput;
}
