import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import type { Command } from 'commander';
import chalk from 'chalk';
import { getContext } from '../context.js';
import { printError, printJson, printInfo, isJsonOutput } from '../output.js';

export function registerLogsCommand(program: Command): void {
  program
    .command('logs <id>')
    .description('Show output from a task')
    .option('--stderr', 'show stderr instead of stdout')
    .option('-f, --follow', 'follow live output (tail mode)')
    .action(async (id: string, options: { stderr?: boolean; follow?: boolean }) => {
      const ctx = await getContext();
      const task = ctx.queue.get(id);

      if (!task) {
        printError(`Task ${id} not found`);
        return;
      }

      // Follow mode: tail the log file
      if (options.follow) {
        const logPath = task.logFile ?? join(process.cwd(), '.openhive', 'logs', `${id}.log`);
        let offset = 0;

        const poll = async (): Promise<boolean> => {
          try {
            const info = await stat(logPath);
            if (info.size > offset) {
              const { open } = await import('node:fs/promises');
              const fh = await open(logPath, 'r');
              const buf = Buffer.alloc(info.size - offset);
              await fh.read(buf, 0, buf.length, offset);
              await fh.close();
              process.stdout.write(buf.toString());
              offset = info.size;
            }
          } catch {
            // Log file doesn't exist yet
          }

          // Reload task state
          try {
            const tasks = await ctx.storage.loadAll();
            ctx.queue.loadAll(tasks);
          } catch {
            // ignore
          }
          const current = ctx.queue.get(id);
          return !!(current && (current.status === 'completed' || current.status === 'failed'));
        };

        // If task is already done, just show stored output
        if (task.status === 'completed' || task.status === 'failed') {
          const done = await poll();
          if (!done) {
            // No log file, fall back to stored output
            const output = options.stderr ? task.stderr : task.stdout;
            if (output?.trim()) console.log(output);
          }
          const statusStr = task.status === 'completed'
            ? chalk.green('completed')
            : chalk.red('failed');
          console.log(`\n${chalk.dim('---')} Task ${statusStr}`);
          return;
        }

        // Poll until done
        await new Promise<void>((resolve) => {
          const interval = setInterval(async () => {
            const done = await poll();
            if (done) {
              clearInterval(interval);
              const current = ctx.queue.get(id);
              const statusStr = current?.status === 'completed'
                ? chalk.green('completed')
                : chalk.red('failed');
              console.log(`\n${chalk.dim('---')} Task ${statusStr}`);
              resolve();
            }
          }, 200);

          process.on('SIGINT', () => {
            clearInterval(interval);
            resolve();
          });
        });
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
