/**
 * WorkerSession — manages a single persistent tmux window for an AI agent.
 *
 * Each worker runs an interactive CLI tool (claude, codex, gemini) in a tmux
 * window. The orchestrator sends prompts by typing into the window and monitors
 * output for state changes.
 */

import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  ensureSession,
  createWindow,
  killWindow,
  isWindowAlive,
  sendKeys,
  sendText,
  capturePane,
  startPipePane,
  stopPipePane,
  getFileSize,
  waitForReady,
  stripAnsi,
  sleep,
} from './tmux.js';
import { TOOL_CONTROLS } from '../agents/tool-control.js';
import { StateDetector } from './state.js';
import { buildProfile } from './patterns.js';
import { logger } from '../utils/logger.js';
import type {
  WorkerInfo,
  WorkerState,
  TaskAssignment,
  StateSnapshot,
  ToolOrchestrationProfile,
  OrchestratorConfig,
} from './types.js';
import type { Task } from '../tasks/task.js';

export class WorkerSession {
  readonly info: WorkerInfo;
  readonly profile: ToolOrchestrationProfile;
  readonly stateDetector: StateDetector;

  private config: OrchestratorConfig;
  private cwd?: string;

  constructor(
    id: string,
    tool: string,
    config: OrchestratorConfig,
    cwd?: string,
  ) {
    this.config = config;
    this.cwd = cwd;
    this.profile = buildProfile(tool, config.autoApprove);
    this.stateDetector = new StateDetector(this.profile);

    const logsDir = join(process.cwd(), '.openhive', 'logs');
    const pipeFile = join(logsDir, `worker-${id}.pipe`);

    this.info = {
      id,
      tool,
      tmuxTarget: '', // Set during start()
      state: 'starting',
      tasksCompleted: 0,
      pipeFile,
      lastPipeSize: 0,
      lastCheckAt: Date.now(),
      lastOutputChangeAt: Date.now(),
      createdAt: Date.now(),
    };
  }

  /**
   * Start the worker: create tmux window, launch the tool, wait for ready.
   */
  async start(): Promise<void> {
    const ctrl = TOOL_CONTROLS[this.info.tool];
    if (!ctrl) throw new Error(`No tool control for: ${this.info.tool}`);

    // Ensure orchestrator session exists
    logger.info(`Worker ${this.info.id}: ensuring tmux session`);
    await ensureSession();

    // Ensure logs directory exists and create empty pipe file
    const logsDir = join(process.cwd(), '.openhive', 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(this.info.pipeFile, '', 'utf-8');

    // Create tmux window with the tool running in it
    const startCmd = [ctrl.startCommand, ...ctrl.startArgs].join(' ');
    logger.info(`Worker ${this.info.id}: creating tmux window (${startCmd})${this.cwd ? ` in ${this.cwd}` : ''}`);
    this.info.tmuxTarget = await createWindow(this.info.id, startCmd, this.cwd);

    // Start pipe-pane for output monitoring
    await startPipePane(this.info.tmuxTarget, this.info.pipeFile);

    // Wait for the tool to be ready for input
    logger.info(`Worker ${this.info.id}: waiting for tool ready...`);
    await waitForReady(
      this.info.tmuxTarget,
      ctrl.readyPattern,
      ctrl.startupDialogPattern,
      { maxWaitMs: 30_000, pollMs: 1000 },
    );

    // Brief delay to let the TUI fully initialize after showing prompt
    await sleep(2000);

    this.updateState('idle');
    logger.info(`Worker ${this.info.id} (${this.info.tool}) started and ready`);
  }

  /**
   * Assign a task to this worker and send the prompt.
   */
  async assignTask(task: Task): Promise<void> {
    if (this.info.state !== 'idle') {
      throw new Error(`Cannot assign task to worker in state: ${this.info.state}`);
    }

    this.info.assignment = {
      task,
      assignedAt: Date.now(),
    };

    // Send the prompt text to the agent
    await sendText(this.info.tmuxTarget, task.prompt);

    this.updateState('working');
    logger.info(`Worker ${this.info.id}: assigned task ${task.id}`);
  }

  /**
   * Check if there's new output since the last check.
   * O(1) stat() call on the pipe file.
   */
  async hasNewOutput(): Promise<boolean> {
    const currentSize = await getFileSize(this.info.pipeFile);
    const hasNew = currentSize > this.info.lastPipeSize;
    if (hasNew) {
      this.info.lastPipeSize = currentSize;
      this.info.lastOutputChangeAt = Date.now();
    }
    return hasNew;
  }

  /**
   * Detect the current worker state via capture-pane + pattern matching.
   */
  async detectState(): Promise<StateSnapshot> {
    const snapshot = await this.stateDetector.detect(this.info.tmuxTarget);

    // Apply stuck detection
    const refined = this.stateDetector.refineState(
      snapshot,
      this.info.lastOutputChangeAt,
      this.config.stuckTimeoutMs,
    );

    // Track idle settling for task completion detection
    if (refined.state === 'idle' && this.info.assignment) {
      if (!this.info.assignment.idleDetectedAt) {
        this.info.assignment.idleDetectedAt = refined.timestamp;
      }
    } else if (refined.state !== 'idle' && this.info.assignment?.idleDetectedAt) {
      // Agent left idle state — reset settling
      this.info.assignment.idleDetectedAt = undefined;
    }

    this.info.lastCheckAt = refined.timestamp;
    return refined;
  }

  /**
   * Send an approval to the agent.
   * All supported agents (claude, codex, gemini) use selection menus where
   * the first (accept) option is pre-selected, so Enter confirms it.
   */
  async approve(): Promise<void> {
    await sendKeys(this.info.tmuxTarget, ['Enter']);
  }

  /**
   * Send Escape to dismiss a dialog or overlay.
   */
  async dismiss(): Promise<void> {
    const ctrl = TOOL_CONTROLS[this.info.tool];
    await sendKeys(this.info.tmuxTarget, [ctrl?.dismissKey ?? 'Escape']);
  }

  /**
   * Send arbitrary keys to the agent.
   */
  async sendKeysToAgent(keys: string[]): Promise<void> {
    await sendKeys(this.info.tmuxTarget, keys);
  }

  /**
   * Type text followed by Enter.
   */
  async sendTextToAgent(text: string): Promise<void> {
    await sendText(this.info.tmuxTarget, text);
  }

  /**
   * Mark the current task as completed and return worker to idle.
   */
  markTaskComplete(): void {
    if (this.info.assignment) {
      logger.info(
        `Worker ${this.info.id}: task ${this.info.assignment.task.id} completed`,
      );
      this.info.tasksCompleted++;
      this.info.assignment = undefined;
    }
    this.updateState('idle');
  }

  /**
   * Mark the current task as failed.
   */
  markTaskFailed(reason: string): void {
    if (this.info.assignment) {
      logger.warn(
        `Worker ${this.info.id}: task ${this.info.assignment.task.id} failed — ${reason}`,
      );
      this.info.assignment = undefined;
    }
    this.updateState('idle');
  }

  /**
   * Check if the tmux window is still alive.
   */
  async isAlive(): Promise<boolean> {
    return isWindowAlive(this.info.tmuxTarget);
  }

  /**
   * Restart the worker: kill existing window and start fresh.
   * Does NOT preserve conversation context.
   */
  async restart(): Promise<void> {
    logger.info(`Worker ${this.info.id}: restarting`);
    await this.stop();
    // Brief delay before restart
    await sleep(1000);
    await this.start();
  }

  /**
   * Stop the worker: stop pipe-pane, kill tmux window.
   */
  async stop(): Promise<void> {
    await stopPipePane(this.info.tmuxTarget);
    await killWindow(this.info.tmuxTarget);
    this.updateState('dead');
    logger.info(`Worker ${this.info.id}: stopped`);
  }

  /**
   * Get current worker state.
   */
  get state(): WorkerState {
    return this.info.state;
  }

  /**
   * Get the current task assignment, if any.
   */
  get assignment(): TaskAssignment | undefined {
    return this.info.assignment;
  }

  /**
   * Whether this worker is available for a new task.
   */
  get isIdle(): boolean {
    return this.info.state === 'idle' && !this.info.assignment;
  }

  private updateState(newState: WorkerState): void {
    if (this.info.state !== newState) {
      logger.debug(
        `Worker ${this.info.id}: ${this.info.state} → ${newState}`,
      );
      this.info.state = newState;
    }
  }
}
