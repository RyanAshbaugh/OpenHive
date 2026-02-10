import type { Command } from 'commander';
import { getContext } from '../context.js';
import { printTable, printJson, printInfo, printSuccess, printError, isJsonOutput, statusColor } from '../output.js';

export function registerTasksCommand(program: Command): void {
  const tasksCmd = program
    .command('tasks')
    .description('List and manage tasks');

  // Default: list tasks
  tasksCmd
    .option('-s, --status <status>', 'filter by status')
    .option('-p, --project <id>', 'filter by project')
    .action(async (options: { status?: string; project?: string }) => {
      const ctx = await getContext();
      let tasks = ctx.queue.list();

      if (options.status) {
        tasks = tasks.filter(t => t.status === options.status);
      }
      if (options.project) {
        tasks = tasks.filter(t => t.projectId === options.project);
      }

      if (tasks.length === 0) {
        if (isJsonOutput()) {
          printJson([]);
        } else {
          printInfo('No tasks found');
        }
        return;
      }

      if (isJsonOutput()) {
        printJson(tasks);
        return;
      }

      const rows = tasks.map(t => [
        t.id,
        statusColor(t.status),
        t.agent ?? '-',
        t.prompt.length > 50 ? t.prompt.slice(0, 47) + '...' : t.prompt,
        t.durationMs ? `${t.durationMs}ms` : '-',
        t.createdAt.slice(0, 19),
      ]);

      printTable(['ID', 'Status', 'Agent', 'Prompt', 'Duration', 'Created'], rows);
    });

  // tasks rm <id>
  tasksCmd
    .command('rm <id>')
    .description('Remove a task from storage')
    .action(async (id: string) => {
      const ctx = await getContext();
      const task = ctx.queue.get(id);
      if (!task) {
        printError(`Task ${id} not found`);
        process.exitCode = 1;
        return;
      }
      if (task.status === 'running') {
        printError(`Task ${id} is still running. Kill it first (dashboard 'x' key or wait for completion).`);
        process.exitCode = 1;
        return;
      }
      await ctx.storage.delete(id);
      ctx.queue.remove(id);
      printSuccess(`Removed task ${id}`);
    });

  // tasks clear
  tasksCmd
    .command('clear')
    .description('Remove all completed and failed tasks')
    .option('-a, --all', 'remove all tasks including pending/queued')
    .action(async (options: { all?: boolean }) => {
      const ctx = await getContext();
      const tasks = ctx.queue.list();
      let removed = 0;

      for (const task of tasks) {
        if (task.status === 'running') continue;
        if (!options.all && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') continue;
        await ctx.storage.delete(task.id);
        ctx.queue.remove(task.id);
        removed++;
      }

      if (removed === 0) {
        printInfo('No tasks to clear');
      } else {
        printSuccess(`Cleared ${removed} task${removed === 1 ? '' : 's'}`);
      }
    });
}
