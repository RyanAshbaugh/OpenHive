import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { OpenHiveConfig } from '../config/schema.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { TaskQueue } from '../tasks/queue.js';
import type { TaskStorage } from '../tasks/storage.js';
import type { PoolTracker } from '../pool/tracker.js';
import type { Task } from '../tasks/task.js';
import { Dispatcher } from './dispatcher.js';
import { createWorktree } from '../git/worktree.js';
import { logger } from '../utils/logger.js';

export class Scheduler {
  private dispatcher: Dispatcher;
  private running = false;

  constructor(
    private config: OpenHiveConfig,
    private registry: AgentRegistry,
    private queue: TaskQueue,
    private storage: TaskStorage,
    private poolTracker: PoolTracker,
  ) {
    this.dispatcher = new Dispatcher(registry, poolTracker, config);
  }

  /** Dispatch a single task immediately */
  async dispatchTask(task: Task): Promise<void> {
    const agent = this.dispatcher.selectAgent(task);
    if (!agent) {
      logger.error(`No available agent for task ${task.id}`);
      this.queue.update(task.id, { status: 'failed', error: 'No available agent' });
      await this.storage.save(this.queue.get(task.id)!);
      return;
    }

    // Create worktree for isolation
    let worktreePath = process.cwd();
    let worktreeBranch: string | undefined;

    try {
      const wt = await createWorktree(task.id, this.config.worktreeDir);
      worktreePath = wt.path;
      worktreeBranch = wt.branch;
    } catch (err) {
      // If worktree creation fails (e.g., not a git repo), run in current dir
      logger.warn(`Worktree creation failed, running in current directory: ${err}`);
    }

    // Set up log file
    const logsDir = join(process.cwd(), '.openhive', 'logs');
    await mkdir(logsDir, { recursive: true });
    const logFile = join(logsDir, `${task.id}.log`);

    // Update task status
    this.queue.update(task.id, {
      status: 'running',
      agent: agent.name,
      worktreePath,
      worktreeBranch,
      logFile,
      startedAt: new Date().toISOString(),
    });
    await this.storage.save(this.queue.get(task.id)!);

    // Track dispatch in pool
    this.poolTracker.recordDispatch(agent.provider);

    // Run the agent
    logger.info(`Dispatching task ${task.id} to ${agent.name}`);
    try {
      const result = await agent.run({
        prompt: task.prompt,
        cwd: worktreePath,
        contextFiles: task.contextFiles,
        logFile,
      });

      const isRateLimit = this.poolTracker.isRateLimitSignal(result.exitCode, result.stdout + result.stderr);

      if (isRateLimit) {
        this.poolTracker.recordFailure(agent.provider, true);
      } else if (result.exitCode !== 0) {
        this.poolTracker.recordFailure(agent.provider, false);
      } else {
        this.poolTracker.recordCompletion(agent.provider);
      }

      const status = result.exitCode === 0 ? 'completed' : 'failed';
      this.queue.update(task.id, {
        status,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        completedAt: new Date().toISOString(),
        error: result.exitCode !== 0 ? `Agent exited with code ${result.exitCode}` : undefined,
      });
    } catch (err) {
      this.poolTracker.recordFailure(agent.provider, false);
      this.queue.update(task.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await this.storage.save(this.queue.get(task.id)!);
  }

  /** Process all pending tasks */
  async processPending(): Promise<void> {
    const pending = this.queue.pending();
    const decisions = this.dispatcher.matchTasks(pending);

    const dispatches = decisions.map(d => this.dispatchTask(d.task));
    await Promise.all(dispatches);
  }

  /** Start the scheduler loop */
  async start(intervalMs = 2000): Promise<void> {
    this.running = true;
    logger.info('Scheduler started');

    while (this.running) {
      await this.processPending();
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
  }

  stop(): void {
    this.running = false;
    logger.info('Scheduler stopped');
  }
}
