/**
 * Main Orchestrator — control loop managing persistent tmux workers.
 *
 * The orchestrator is a deterministic state machine. Each tick:
 *   1. Dispatch pending tasks to idle workers (or create new workers)
 *   2. Monitor all active workers (detect state, decide action, execute)
 *   3. Clean up dead workers
 *
 * Tier 1 decisions are instant programmatic rules (zero tokens).
 * Tier 2 escalates to a headless LLM call when rules don't match.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { WorkerSession } from './worker.js';
import { ResponseEngine } from './response.js';
import { buildProfile, supportedTools } from './patterns.js';
import { killSession, sleep } from './tmux.js';
import { generateShortId } from '../utils/id.js';
import { logger } from '../utils/logger.js';
import { createWorktree } from '../git/worktree.js';
import type {
  OrchestratorConfig,
  OrchestratorAction,
  OrchestratorEvent,
  OrchestratorEventHandler,
  OrchestrationSessionState,
  WorkerState,
} from './types.js';
import { DEFAULT_ORCHESTRATOR_CONFIG as DEFAULTS } from './types.js';
import type { Task } from '../tasks/task.js';
import type { TaskStorage } from '../tasks/storage.js';

export interface OrchestratorOptions {
  config?: Partial<OrchestratorConfig>;
  onEvent?: OrchestratorEventHandler;
  taskStorage?: TaskStorage;
}

export class Orchestrator {
  private config: OrchestratorConfig;
  private workers: Map<string, WorkerSession> = new Map();
  private responseEngines: Map<string, ResponseEngine> = new Map();
  private running = false;
  private onEvent?: OrchestratorEventHandler;
  private taskStorage?: TaskStorage;

  /** Tasks queued for dispatch */
  private pendingTasks: Task[] = [];

  /** Tasks completed during this session */
  private completedTaskIds: Set<string> = new Set();

  /** Tasks failed during this session */
  private failedTasks: Map<string, string> = new Map(); // taskId → reason

  /** Rate limit cooldowns per tool — tool → resumeAt timestamp */
  private providerCooldowns: Map<string, number> = new Map();

  /** Context affinity: maps task IDs to worker IDs for routing dependent tasks */
  private taskWorkerAffinity: Map<string, string> = new Map();

  /** Dependency hints: maps task IDs to the IDs of tasks they depend on */
  private taskDependencies: Map<string, string[]> = new Map();

  /** Dispatch retry counts — taskId → attempts */
  private dispatchRetries: Map<string, number> = new Map();

  /** Max dispatch retries before failing a task */
  private readonly maxDispatchRetries = 5;

  constructor(options?: OrchestratorOptions) {
    // Strip undefined values from config so they don't overwrite defaults
    const overrides: Record<string, unknown> = {};
    if (options?.config) {
      for (const [k, v] of Object.entries(options.config)) {
        if (v !== undefined) overrides[k] = v;
      }
    }
    this.config = { ...DEFAULTS, ...overrides } as OrchestratorConfig;
    this.onEvent = options?.onEvent;
    this.taskStorage = options?.taskStorage;
  }

  /**
   * Queue a task for dispatch. The orchestrator will assign it to an idle
   * worker (or create a new one) on the next tick.
   *
   * @param dependsOn IDs of tasks this task depends on (for context affinity routing)
   */
  queueTask(task: Task, dependsOn?: string[]): void {
    this.pendingTasks.push(task);
    if (dependsOn?.length) {
      this.taskDependencies.set(task.id, dependsOn);
    }
    logger.info(`Orchestrator: queued task ${task.id}`);
    this.persistTask(task);
  }

  /**
   * Queue multiple tasks.
   */
  queueTasks(tasks: Task[]): void {
    for (const task of tasks) {
      this.queueTask(task);
    }
  }

  /**
   * Start the orchestrator control loop.
   * Runs until stop() is called or all tasks are complete with no pending work.
   * Installs SIGINT/SIGTERM handlers for graceful shutdown.
   */
  async start(): Promise<void> {
    this.running = true;
    logger.info('Orchestrator started');

    // Graceful shutdown on signals — run full shutdown to kill tmux,
    // cancel pending tasks, and clean up state files.
    const signalHandler = () => {
      logger.info('Orchestrator: received shutdown signal');
      this.running = false;
      this.shutdown().catch(() => {});
    };
    process.on('SIGINT', signalHandler);
    process.on('SIGTERM', signalHandler);

    try {
      while (this.running) {
        try {
          await this.tick();
        } catch (err) {
          logger.error(`Orchestrator tick error: ${err}`);
        }

        // Check if we're done: no pending tasks, no active assignments
        if (this.pendingTasks.length === 0 && !this.hasActiveAssignments()) {
          logger.info('Orchestrator: all tasks processed, stopping');
          break;
        }

        await sleep(this.config.tickIntervalMs);
      }
    } finally {
      process.removeListener('SIGINT', signalHandler);
      process.removeListener('SIGTERM', signalHandler);
    }

    this.running = false;
    logger.info('Orchestrator stopped');
  }

  /**
   * Run a single orchestrator tick.
   * Exposed for testing and manual stepping.
   */
  async tick(): Promise<void> {
    // 1. Dispatch pending tasks to idle workers
    await this.dispatchPending();

    // 2. Monitor all active workers
    await this.monitorWorkers();

    // 3. Clean up dead workers
    await this.cleanupDeadWorkers();

    // 4. Write session state for TUI visibility
    await this.writeSessionState();
  }

  /**
   * Stop the orchestrator loop.
   */
  stop(): void {
    this.running = false;
  }

  /**
   * Graceful shutdown: stop all workers and kill the tmux session.
   */
  async shutdown(): Promise<void> {
    this.stop();

    // Stop all workers
    const stopPromises = Array.from(this.workers.values()).map(w => w.stop());
    await Promise.allSettled(stopPromises);
    this.workers.clear();
    this.responseEngines.clear();

    // Mark any remaining pending tasks as cancelled so they don't linger
    // in shared storage as "pending" after this orchestrator exits.
    if (this.taskStorage) {
      for (const task of this.pendingTasks) {
        task.status = 'cancelled';
        task.completedAt = new Date().toISOString();
        await this.taskStorage.save(task).catch(() => {});
      }
    }
    this.pendingTasks = [];

    // Write final "stopped" state for TUI
    await this.clearSessionState();

    // Kill the orchestrator session
    await killSession();
    logger.info('Orchestrator: shutdown complete');
  }

  /**
   * Get the status of all workers.
   */
  getWorkerStates(): Array<{
    id: string;
    tool: string;
    state: WorkerState;
    taskId?: string;
    tasksCompleted: number;
  }> {
    return Array.from(this.workers.values()).map(w => ({
      id: w.info.id,
      tool: w.info.tool,
      state: w.info.state,
      taskId: w.info.assignment?.task.id,
      tasksCompleted: w.info.tasksCompleted,
    }));
  }

  /**
   * Check if a specific task has completed.
   */
  isTaskCompleted(taskId: string): boolean {
    return this.completedTaskIds.has(taskId);
  }

  /**
   * Check if a specific task has failed.
   */
  isTaskFailed(taskId: string): boolean {
    return this.failedTasks.has(taskId);
  }

  /**
   * Get the failure reason for a task.
   */
  getFailureReason(taskId: string): string | undefined {
    return this.failedTasks.get(taskId);
  }

  /**
   * Whether the orchestrator loop is running.
   */
  get isRunning(): boolean {
    return this.running;
  }

  // ─── Internal: Dispatch ──────────────────────────────────────────────────

  private async dispatchPending(): Promise<void> {
    if (this.pendingTasks.length === 0) return;

    // Dispatch as many pending tasks as we have capacity for
    const toDispatch: Array<{ index: number; task: Task; tool: string }> = [];

    for (let i = 0; i < this.pendingTasks.length; i++) {
      const task = this.pendingTasks[i];
      const tool = task.agent ?? 'claude';

      if (!supportedTools().includes(tool)) {
        logger.error(`Orchestrator: unsupported tool "${tool}" for task ${task.id}`);
        this.pendingTasks.splice(i, 1);
        i--;
        this.failedTasks.set(task.id, `Unsupported tool: ${tool}`);
        task.status = 'failed';
        task.error = `Unsupported tool: ${tool}`;
        task.completedAt = new Date().toISOString();
        this.persistTask(task);
        this.emit({ type: 'task_failed', workerId: '', taskId: task.id, reason: `Unsupported tool: ${tool}` });
        continue;
      }

      toDispatch.push({ index: i, task, tool });
    }

    // Track which tasks we successfully dispatch (to remove from pending)
    const dispatched: Set<string> = new Set();

    for (const { task, tool } of toDispatch) {
      // Rate limit coordination: skip tasks for providers in cooldown
      const cooldownUntil = this.providerCooldowns.get(tool);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        continue; // Provider is cooling down — try again next tick
      }
      // Clear expired cooldown
      if (cooldownUntil && Date.now() >= cooldownUntil) {
        this.providerCooldowns.delete(tool);
      }

      // Track dispatch attempts for this task
      const attempts = (this.dispatchRetries.get(task.id) ?? 0) + 1;
      this.dispatchRetries.set(task.id, attempts);

      if (attempts > this.maxDispatchRetries) {
        const reason = `Failed to dispatch after ${this.maxDispatchRetries} attempts`;
        logger.error(`Orchestrator: giving up on task ${task.id} (tool=${tool}): ${reason}`);
        dispatched.add(task.id); // Remove from pending
        this.failedTasks.set(task.id, reason);
        task.status = 'failed';
        task.error = reason;
        task.completedAt = new Date().toISOString();
        this.persistTask(task);
        this.emit({ type: 'task_failed', workerId: '', taskId: task.id, reason });
        continue;
      }

      // Create worktree for isolation if enabled
      if (this.config.useWorktrees && !task.worktreePath) {
        try {
          const wt = await createWorktree(task.id, this.config.worktreeDir, this.config.repoRoot);
          task.worktreePath = wt.path;
          task.worktreeBranch = wt.branch;
          logger.info(`Orchestrator: created worktree for task ${task.id} at ${wt.path}`);
        } catch (err) {
          logger.warn(`Orchestrator: worktree creation failed for task ${task.id}, proceeding without isolation: ${err}`);
        }
      }

      // Context affinity: prefer a worker that handled a dependency of this task
      let worker = this.findAffinityWorker(task, tool) ?? this.findIdleWorker(tool);
      if (!worker && this.workers.size < this.config.maxWorkers) {
        try {
          worker = await this.createWorker(tool, task.worktreePath);
        } catch (err) {
          const level = attempts >= this.maxDispatchRetries ? 'error' : 'warn';
          logger[level](`Failed to create worker for ${tool} (attempt ${attempts}/${this.maxDispatchRetries}): ${err}`);
          continue;
        }
      }

      if (!worker) {
        // No available worker and at capacity — wait for next tick
        logger.debug(`No worker available for task ${task.id} (attempt ${attempts})`);
        continue;
      }

      try {
        await worker.assignTask(task);
        dispatched.add(task.id);
        this.dispatchRetries.delete(task.id);
        // Persist running state
        task.status = 'running';
        task.workerId = worker.info.id;
        task.startedAt = new Date().toISOString();
        await this.persistTask(task);
        this.emit({ type: 'task_assigned', workerId: worker.info.id, taskId: task.id });
      } catch (err) {
        logger.error(`Failed to assign task ${task.id} to worker ${worker.info.id}: ${err}`);
      }
    }

    // Remove dispatched tasks from pending
    this.pendingTasks = this.pendingTasks.filter(t => !dispatched.has(t.id));
  }

  // ─── Internal: Monitor ───────────────────────────────────────────────────

  private async monitorWorkers(): Promise<void> {
    for (const [id, worker] of this.workers) {
      try {
        // Wall-clock task timeout: force-fail if exceeded
        if (
          this.config.taskTimeoutMs > 0 &&
          worker.assignment &&
          Date.now() - worker.assignment.assignedAt > this.config.taskTimeoutMs
        ) {
          const reason = `Task exceeded wall-clock timeout of ${this.config.taskTimeoutMs}ms`;
          logger.warn(`Worker ${id}: ${reason}`);
          await this.executeAction(worker, { type: 'mark_failed', reason });
          continue;
        }

        // Check for new output (O(1) stat)
        const hasNew = await worker.hasNewOutput();
        const timeSinceCheck = Date.now() - worker.info.lastCheckAt;

        // Only do full state detection if there's new output or periodic check
        if (!hasNew && timeSinceCheck < 5000) continue;

        const snapshot = await worker.detectState();
        const engine = this.getResponseEngine(worker.info.tool);
        const action = engine.decide(snapshot, worker.info, worker.assignment);

        logger.info(
          `Monitor ${id}: detected=${snapshot.state} (${snapshot.matchedPattern ?? 'none'}) → action=${action.type}`,
        );

        // Track state changes
        if (snapshot.state !== worker.info.state) {
          const from = worker.info.state;
          worker.info.state = snapshot.state;
          this.emit({ type: 'state_changed', workerId: id, from, to: snapshot.state });

          // Persist workerState on the assigned task
          if (worker.assignment) {
            worker.assignment.task.workerState = snapshot.state;
            await this.persistTask(worker.assignment.task);
          }

          // Rate limit coordination: when one worker hits a rate limit,
          // set a cooldown for all workers of that tool/provider
          if (snapshot.state === 'rate_limited') {
            const cooldownUntil = Date.now() + 60_000;
            this.providerCooldowns.set(worker.info.tool, cooldownUntil);
            logger.info(
              `Provider ${worker.info.tool} rate limited — cooling down all workers for 60s`,
            );
          }
        }

        await this.executeAction(worker, action);
      } catch (err) {
        logger.error(`Error monitoring worker ${id}: ${err}`);
      }
    }
  }

  // ─── Internal: Execute Action ────────────────────────────────────────────

  private async executeAction(
    worker: WorkerSession,
    action: OrchestratorAction,
  ): Promise<void> {
    if (action.type === 'noop') return;

    logger.debug(
      `Orchestrator: executing ${action.type} on worker ${worker.info.id}`,
    );
    this.emit({ type: 'action_taken', workerId: worker.info.id, action });

    switch (action.type) {
      case 'send_keys':
        await worker.sendKeysToAgent(action.keys);
        break;

      case 'send_text':
        await worker.sendTextToAgent(action.text);
        break;

      case 'approve':
        await worker.approve();
        break;

      case 'dismiss':
        await worker.dismiss();
        break;

      case 'wait':
        // Don't actually block — just skip this worker for the specified duration
        // by updating lastCheckAt to create a delay
        worker.info.lastCheckAt = Date.now() + action.durationMs;
        break;

      case 'restart':
        await this.restartWorker(worker);
        break;

      case 'escalate_llm': {
        const engine = this.getResponseEngine(worker.info.tool);
        try {
          const escalation = await engine.resolveEscalation(
            // Use the latest snapshot for context
            await worker.detectState(),
            worker.info,
            worker.assignment,
          );
          this.emit({
            type: 'llm_escalation',
            workerId: worker.info.id,
            rawResponse: escalation.rawResponse,
            resolvedAction: escalation.action.type,
            durationMs: escalation.durationMs,
          });
          // Execute the resolved action (no recursion — resolved actions are never escalate_llm)
          if (escalation.action.type !== 'escalate_llm') {
            await this.executeAction(worker, escalation.action);
          }
        } catch (err) {
          logger.error(`LLM escalation failed for worker ${worker.info.id}: ${err}`);
          // Fallback: if escalation fails, wait and retry next tick
          worker.info.lastCheckAt = Date.now() + 30_000;
        }
        break;
      }

      case 'mark_complete': {
        const taskId = worker.assignment?.task.id;
        const completedTask = worker.assignment?.task;
        worker.markTaskComplete();
        if (taskId) {
          this.completedTaskIds.add(taskId);
          // Record affinity: this task was completed by this worker
          this.taskWorkerAffinity.set(taskId, worker.info.id);
          // Persist completed state
          if (completedTask) {
            completedTask.status = 'completed';
            completedTask.completedAt = new Date().toISOString();
            completedTask.workerState = undefined;
            await this.persistTask(completedTask);
          }
          this.emit({ type: 'task_completed', workerId: worker.info.id, taskId });
        }
        // Worker recycling: restart after maxTasksPerWorker tasks
        if (
          this.config.maxTasksPerWorker > 0 &&
          worker.info.tasksCompleted >= this.config.maxTasksPerWorker
        ) {
          logger.info(
            `Worker ${worker.info.id}: recycling after ${worker.info.tasksCompleted} tasks`,
          );
          await this.restartWorker(worker);
        }
        break;
      }

      case 'mark_failed': {
        const taskId = worker.assignment?.task.id;
        const failedTask = worker.assignment?.task;
        worker.markTaskFailed(action.reason);
        if (taskId) {
          this.failedTasks.set(taskId, action.reason);
          // Persist failed state
          if (failedTask) {
            failedTask.status = 'failed';
            failedTask.completedAt = new Date().toISOString();
            failedTask.error = action.reason;
            failedTask.workerState = undefined;
            await this.persistTask(failedTask);
          }
          this.emit({
            type: 'task_failed',
            workerId: worker.info.id,
            taskId,
            reason: action.reason,
          });
        }
        break;
      }
    }
  }

  // ─── Internal: Worker Lifecycle ──────────────────────────────────────────

  private async createWorker(tool: string, cwd?: string): Promise<WorkerSession> {
    const id = `${tool}-${generateShortId()}`;
    const worker = new WorkerSession(id, tool, this.config, cwd);
    await worker.start();
    this.workers.set(id, worker);
    this.emit({ type: 'worker_created', workerId: id, tool });
    return worker;
  }

  private findIdleWorker(tool: string): WorkerSession | undefined {
    for (const worker of this.workers.values()) {
      if (worker.info.tool === tool && worker.isIdle && !this.needsRecycling(worker)) {
        return worker;
      }
    }
    return undefined;
  }

  /**
   * Find an idle worker that handled a dependency of this task.
   * Returns undefined if no affinity match found.
   */
  private findAffinityWorker(task: Task, tool: string): WorkerSession | undefined {
    const deps = this.taskDependencies.get(task.id);
    if (!deps?.length) return undefined;

    for (const depId of deps) {
      const workerId = this.taskWorkerAffinity.get(depId);
      if (!workerId) continue;

      const worker = this.workers.get(workerId);
      if (worker && worker.info.tool === tool && worker.isIdle && !this.needsRecycling(worker)) {
        logger.debug(
          `Context affinity: routing task ${task.id} to worker ${workerId} (handled dep ${depId})`,
        );
        return worker;
      }
    }

    return undefined;
  }

  private needsRecycling(worker: WorkerSession): boolean {
    return (
      this.config.maxTasksPerWorker > 0 &&
      worker.info.tasksCompleted >= this.config.maxTasksPerWorker
    );
  }

  private async restartWorker(worker: WorkerSession): Promise<void> {
    try {
      await worker.restart();
      this.emit({ type: 'worker_restarted', workerId: worker.info.id });
    } catch (err) {
      logger.error(`Failed to restart worker ${worker.info.id}: ${err}`);
      this.workers.delete(worker.info.id);
      this.emit({ type: 'worker_died', workerId: worker.info.id });
    }
  }

  private async cleanupDeadWorkers(): Promise<void> {
    for (const [id, worker] of this.workers) {
      if (worker.state === 'dead') continue;

      const alive = await worker.isAlive();
      if (!alive) {
        logger.warn(`Worker ${id} is dead`);
        worker.info.state = 'dead';

        // If the worker had an assigned task, requeue it
        if (worker.assignment) {
          const task = worker.assignment.task;
          logger.info(`Requeuing task ${task.id} from dead worker ${id}`);
          this.pendingTasks.push(task);
          worker.markTaskFailed('Worker died');
        }

        this.emit({ type: 'worker_died', workerId: id });
        this.workers.delete(id);
      }
    }
  }

  private hasActiveAssignments(): boolean {
    for (const worker of this.workers.values()) {
      if (worker.assignment) return true;
    }
    return false;
  }

  private getResponseEngine(tool: string): ResponseEngine {
    let engine = this.responseEngines.get(tool);
    if (!engine) {
      const profile = buildProfile(tool, this.config.autoApprove);
      engine = new ResponseEngine(profile, this.config);
      this.responseEngines.set(tool, engine);
    }
    return engine;
  }

  // ─── Internal: Session State File ──────────────────────────────────────

  private sessionStateFile(): string {
    return join(homedir(), '.openhive', 'orchestration-state.json');
  }

  private async writeSessionState(): Promise<void> {
    const state: OrchestrationSessionState = {
      status: 'running',
      workers: Array.from(this.workers.values()).map(w => ({
        id: w.info.id,
        tool: w.info.tool,
        state: w.info.state,
        taskId: w.info.assignment?.task.id,
        taskPrompt: w.info.assignment?.task.prompt.slice(0, 120),
        tasksCompleted: w.info.tasksCompleted,
        assignedAt: w.info.assignment?.assignedAt,
      })),
      pendingTaskCount: this.pendingTasks.length,
      completedTaskCount: this.completedTaskIds.size,
      failedTaskCount: this.failedTasks.size,
      updatedAt: new Date().toISOString(),
    };

    try {
      const filePath = this.sessionStateFile();
      await mkdir(join(filePath, '..'), { recursive: true });
      await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
      logger.debug(`Failed to write session state: ${err}`);
    }
  }

  private async clearSessionState(): Promise<void> {
    try {
      const state: OrchestrationSessionState = {
        status: 'stopped',
        workers: [],
        pendingTaskCount: 0,
        completedTaskCount: this.completedTaskIds.size,
        failedTaskCount: this.failedTasks.size,
        updatedAt: new Date().toISOString(),
      };
      await writeFile(this.sessionStateFile(), JSON.stringify(state, null, 2), 'utf-8');
    } catch {
      // ignore
    }
  }

  private async persistTask(task: Task): Promise<void> {
    if (this.taskStorage) {
      try {
        await this.taskStorage.save(task);
      } catch (err) {
        logger.debug(`Failed to persist task ${task.id}: ${err}`);
      }
    }
  }

  private emit(event: OrchestratorEvent): void {
    if (this.onEvent) {
      try {
        this.onEvent(event);
      } catch (err) {
        logger.error(`Event handler error: ${err}`);
      }
    }
  }
}
