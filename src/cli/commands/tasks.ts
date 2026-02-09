import type { Command } from 'commander';
import { getContext } from '../context.js';
import { printTable, printJson, printInfo, isJsonOutput, statusColor } from '../output.js';

export function registerTasksCommand(program: Command): void {
  program
    .command('tasks')
    .description('List all tasks')
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
}
