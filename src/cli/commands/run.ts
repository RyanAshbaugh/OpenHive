import type { Command } from 'commander';
import ora from 'ora';
import { getContext } from '../context.js';
import { printSuccess, printError, printJson, isJsonOutput, statusColor } from '../output.js';
import { createTask } from '../../tasks/task.js';
import { generateId } from '../../utils/id.js';

export function registerRunCommand(program: Command): void {
  program
    .command('run <prompt>')
    .description('Create and dispatch a task to an AI agent')
    .option('-a, --agent <name>', 'specify which agent to use')
    .option('-p, --project <id>', 'associate with a project')
    .option('-f, --file <path...>', 'context files to pass to the agent')
    .option('--no-worktree', 'run in current directory instead of a worktree')
    .action(async (prompt: string, options: {
      agent?: string;
      project?: string;
      file?: string[];
      worktree?: boolean;
    }) => {
      const ctx = await getContext();

      // Ensure agents are checked
      await ctx.registry.checkAll(ctx.config);

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
