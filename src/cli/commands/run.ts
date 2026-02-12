import type { Command } from 'commander';
import ora from 'ora';
import { getContext } from '../context.js';
import { printSuccess, printError, printJson, isJsonOutput, statusColor } from '../output.js';
import { createTask } from '../../tasks/task.js';
import { generateId } from '../../utils/id.js';
import { Orchestrator } from '../../orchestrator/orchestrator.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run <prompt>')
    .description('Create and dispatch a task to an AI agent')
    .option('-a, --agent <name>', 'specify which agent to use')
    .option('-p, --project <id>', 'associate with a project')
    .option('-f, --file <path...>', 'context files to pass to the agent')
    .option('--no-worktree', 'run in current directory instead of a worktree')
    .option('--orchestrated', 'use persistent tmux sessions instead of subprocess dispatch')
    .action(async (prompt: string, options: {
      agent?: string;
      project?: string;
      file?: string[];
      worktree?: boolean;
      orchestrated?: boolean;
    }) => {
      const ctx = await getContext();

      // Ensure agents are checked
      await ctx.registry.checkAll(ctx.config);

      // Check if orchestrated mode is enabled (flag or config)
      const useOrchestrator = options.orchestrated || ctx.config.orchestrator?.enabled;

      // Create the task
      const task = createTask(prompt, generateId(), {
        agent: options.agent,
        projectId: options.project,
        contextFiles: options.file,
      });
      ctx.queue.add(task);
      await ctx.storage.save(task);

      // Associate with project if specified
      if (options.project) {
        ctx.projectManager.addTask(options.project, task.id);
      }

      if (useOrchestrator) {
        await runOrchestrated(task.id, ctx);
        return;
      }

      if (isJsonOutput()) {
        // Dispatch without spinner
        await ctx.scheduler.dispatchTask(task);
        const updated = ctx.queue.get(task.id)!;
        printJson(updated);
        return;
      }

      const spinner = ora(`Dispatching task ${task.id}...`).start();

      try {
        await ctx.scheduler.dispatchTask(task);
        const updated = ctx.queue.get(task.id)!;
        spinner.stop();

        if (updated.status === 'completed') {
          printSuccess(`Task ${task.id} completed by ${updated.agent} (${updated.durationMs}ms)`);
          if (updated.stdout?.trim()) {
            console.log('\n' + updated.stdout.trim());
          }
        } else if (updated.status === 'failed') {
          printError(`Task ${task.id} failed: ${updated.error}`);
          if (updated.stderr?.trim()) {
            console.error('\n' + updated.stderr.trim());
          }
        } else {
          console.log(`Task ${task.id} status: ${statusColor(updated.status)}`);
        }
      } catch (err) {
        spinner.stop();
        printError(`Dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
}

async function runOrchestrated(
  taskId: string,
  ctx: Awaited<ReturnType<typeof getContext>>,
): Promise<void> {
  const task = ctx.queue.get(taskId)!;
  const orchConfig = ctx.config.orchestrator ?? {};

  const orchestrator = new Orchestrator({
    config: {
      maxWorkers: orchConfig.maxWorkers,
      autoApprove: orchConfig.autoApprove,
      tickIntervalMs: orchConfig.tickIntervalMs,
      stuckTimeoutMs: orchConfig.stuckTimeoutMs,
      llmEscalationTool: orchConfig.llmEscalationTool,
      llmContextLines: orchConfig.llmContextLines,
    },
    taskStorage: ctx.storage,
    onEvent: (event) => {
      if (isJsonOutput()) return;
      switch (event.type) {
        case 'worker_created':
          console.error(`  Worker ${event.workerId} (${event.tool}) created`);
          break;
        case 'task_assigned':
          console.error(`  Task assigned to worker`);
          break;
        case 'state_changed':
          console.error(`  Worker: ${event.from} → ${event.to}`);
          break;
        case 'task_completed':
          printSuccess(`Task ${taskId} completed (orchestrated)`);
          break;
        case 'task_failed':
          printError(`Task ${taskId} failed: ${event.reason}`);
          break;
      }
    },
  });

  orchestrator.queueTask(task);

  try {
    await orchestrator.start();
  } finally {
    await orchestrator.shutdown();
  }

  // Orchestrator persists task state to storage — sync the in-memory queue
  const completed = orchestrator.isTaskCompleted(taskId);
  const failReason = orchestrator.getFailureReason(taskId);
  ctx.queue.update(taskId, {
    status: completed ? 'completed' : 'failed',
    completedAt: new Date().toISOString(),
    error: failReason,
  });

  if (isJsonOutput()) {
    printJson({
      id: taskId,
      status: completed ? 'completed' : 'failed',
      reason: failReason,
      orchestrated: true,
    });
  }
}
