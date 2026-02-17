/**
 * Context gathering utilities for `openhive do` and `openhive chat`.
 *
 * Assembles context from various sources (stdin, files, tmux panes, task logs)
 * into a single string that can be prepended to a prompt.
 */

import { readFile } from 'node:fs/promises';
import { capturePane, stripAnsi } from '../orchestrator/tmux.js';
import { TaskStorage } from '../tasks/storage.js';
import { logger } from '../utils/logger.js';

/**
 * Read piped stdin if the stream is not a TTY.
 * Returns null when stdin is interactive (no pipe).
 */
export async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;

  return new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8').trim();
      resolve(text.length > 0 ? text : null);
    });
    process.stdin.on('error', () => resolve(null));

    // Safety timeout — don't hang forever if stdin is a broken pipe
    setTimeout(() => {
      if (chunks.length === 0) resolve(null);
    }, 3000);
  });
}

/**
 * Capture the current content of a tmux pane.
 * @param target - tmux target (e.g. "session:window.pane" or "hive:0.2")
 */
export async function readTmuxPane(target: string): Promise<string> {
  const raw = await capturePane(target, -100);
  return stripAnsi(raw).trim();
}

/**
 * Read the stdout/stderr log from a previously-run task.
 * @param taskId - task identifier
 * @param storageDir - task storage directory
 */
export async function readTaskLog(taskId: string, storageDir: string): Promise<string> {
  const storage = new TaskStorage(storageDir);
  const task = await storage.load(taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }

  const parts: string[] = [];
  if (task.stdout) parts.push(task.stdout);
  if (task.stderr) parts.push(task.stderr);
  if (task.error) parts.push(`Error: ${task.error}`);

  if (parts.length === 0) {
    return `Task ${taskId} (status: ${task.status}) — no output recorded.`;
  }

  return parts.join('\n').trim();
}

export interface GatherContextOptions {
  /** File paths to read and include as context */
  files?: string[];
  /** tmux target to capture pane content from */
  tmuxTarget?: string;
  /** Task ID to read log from */
  taskId?: string;
  /** Task storage directory (needed if taskId is set) */
  storageDir?: string;
  /** Pre-read stdin text (call readStdinIfPiped() before gathering) */
  stdinText?: string | null;
}

/**
 * Gather context from all configured sources and combine into a single string.
 * Each source is wrapped in a labeled section.
 */
export async function gatherContext(options: GatherContextOptions): Promise<string> {
  const sections: string[] = [];

  // Piped stdin
  if (options.stdinText) {
    sections.push(`[stdin]\n${options.stdinText}\n[/stdin]`);
  }

  // Files
  if (options.files?.length) {
    for (const filePath of options.files) {
      try {
        const content = await readFile(filePath, 'utf-8');
        sections.push(`[file: ${filePath}]\n${content.trim()}\n[/file]`);
      } catch (err) {
        logger.warn(`Failed to read context file ${filePath}: ${err}`);
        sections.push(`[file: ${filePath}]\n(failed to read: ${err})\n[/file]`);
      }
    }
  }

  // tmux pane
  if (options.tmuxTarget) {
    try {
      const paneContent = await readTmuxPane(options.tmuxTarget);
      sections.push(`[tmux: ${options.tmuxTarget}]\n${paneContent}\n[/tmux]`);
    } catch (err) {
      logger.warn(`Failed to capture tmux pane ${options.tmuxTarget}: ${err}`);
      sections.push(`[tmux: ${options.tmuxTarget}]\n(failed to capture: ${err})\n[/tmux]`);
    }
  }

  // Task log
  if (options.taskId) {
    try {
      const storageDir = options.storageDir ?? '';
      const log = await readTaskLog(options.taskId, storageDir);
      sections.push(`[task: ${options.taskId}]\n${log}\n[/task]`);
    } catch (err) {
      logger.warn(`Failed to read task log ${options.taskId}: ${err}`);
      sections.push(`[task: ${options.taskId}]\n(failed to read: ${err})\n[/task]`);
    }
  }

  return sections.join('\n\n');
}
