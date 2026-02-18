import type { Command } from 'commander';
import chalk from 'chalk';
import { getContext } from '../context.js';
import { printJson, printError, printInfo, isJsonOutput, statusColor } from '../output.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status [id]')
    .description('Show task status (or overall status if no ID)')
    .action(async (id?: string) => {
      const ctx = await getContext();

      if (id) {
        // Show specific task
        const task = ctx.queue.get(id);
        if (!task) {
          printError(`Task ${id} not found`);
          return;
        }

        if (isJsonOutput()) {
          printJson(task);
          return;
        }

        console.log(`${chalk.bold('Task:')} ${task.id}`);
        console.log(`${chalk.bold('Status:')} ${statusColor(task.status)}`);
        console.log(`${chalk.bold('Prompt:')} ${task.prompt}`);
        console.log(`${chalk.bold('Agent:')} ${task.agent ?? '-'}`);
        if (task.projectId) console.log(`${chalk.bold('Project:')} ${task.projectId}`);
        if (task.worktreeBranch) console.log(`${chalk.bold('Branch:')} ${task.worktreeBranch}`);
        console.log(`${chalk.bold('Created:')} ${task.createdAt}`);
        if (task.startedAt) console.log(`${chalk.bold('Started:')} ${task.startedAt}`);
        if (task.completedAt) console.log(`${chalk.bold('Completed:')} ${task.completedAt}`);
        if (task.durationMs) console.log(`${chalk.bold('Duration:')} ${task.durationMs}ms`);
        if (task.error) console.log(`${chalk.bold('Error:')} ${chalk.red(task.error)}`);
        return;
      }

      // Show overall status
      const all = ctx.queue.list();
      const pending = all.filter(t => t.status === 'pending').length;
      const running = all.filter(t => t.status === 'running').length;
      const completed = all.filter(t => t.status === 'completed').length;
      const failed = all.filter(t => t.status === 'failed').length;

      if (isJsonOutput()) {
        printJson({ total: all.length, pending, running, completed, failed });
        return;
      }

      if (all.length === 0) {
        printInfo('No tasks. Run `openhive run "<task>"` to get started.');
        return;
      }

      console.log(chalk.bold('OpenHive Status'));
      console.log(`  Total:     ${all.length}`);
      console.log(`  Pending:   ${chalk.yellow(String(pending))}`);
      console.log(`  Running:   ${chalk.blue(String(running))}`);
      console.log(`  Completed: ${chalk.green(String(completed))}`);
      console.log(`  Failed:    ${chalk.red(String(failed))}`);
    });
}
