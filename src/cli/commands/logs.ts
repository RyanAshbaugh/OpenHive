import type { Command } from 'commander';
import { getContext } from '../context.js';
import { printError, printJson, printInfo, isJsonOutput } from '../output.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <id>')
    .description('Show output from a task')
    .option('--stderr', 'show stderr instead of stdout')
    .action(async (id: string, options: { stderr?: boolean }) => {
      const ctx = await getContext();
      const task = ctx.queue.get(id);

      if (!task) {
        printError(`Task ${id} not found`);
        return;
      }

      if (isJsonOutput()) {
        printJson({
          id: task.id,
          stdout: task.stdout ?? '',
          stderr: task.stderr ?? '',
        });
        return;
      }

      const output = options.stderr ? task.stderr : task.stdout;
      if (!output?.trim()) {
        printInfo(`No ${options.stderr ? 'stderr' : 'stdout'} output for task ${id}`);
        return;
      }

      console.log(output);
    });
}
