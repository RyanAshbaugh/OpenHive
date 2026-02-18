import type { Command } from 'commander';
import { getContext } from '../context.js';
import { printError, printSuccess, printJson, printInfo, isJsonOutput } from '../output.js';
import { getWorktreeDiff, removeWorktree } from '../../git/worktree.js';
import { mergeWorktree, type MergeStrategy } from '../../git/merge.js';

export function registerReviewCommands(program: Command): void {
  program
    .command('diff <id>')
    .description('Show the diff for a task worktree')
    .action(async (id: string) => {
      const ctx = await getContext();
      const task = ctx.queue.get(id);

      if (!task) {
        printError(`Task ${id} not found`);
        return;
      }

      if (!task.worktreePath) {
        printError(`Task ${id} has no worktree`);
        return;
      }

      try {
        const diff = await getWorktreeDiff(task.worktreePath);
        if (isJsonOutput()) {
          printJson({ id: task.id, diff });
        } else if (diff.trim()) {
          console.log(diff);
        } else {
          printInfo('No changes in worktree');
        }
      } catch (err) {
        printError(`Failed to get diff: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  program
    .command('merge <id>')
    .description('Merge task worktree changes back')
    .option('-s, --strategy <strategy>', 'merge strategy: merge, squash, rebase', 'merge')
    .option('--cleanup', 'remove worktree after merge')
    .action(async (id: string, options: { strategy: string; cleanup?: boolean }) => {
      const ctx = await getContext();
      const task = ctx.queue.get(id);

      if (!task) {
        printError(`Task ${id} not found`);
        return;
      }

      if (!task.worktreeBranch) {
        printError(`Task ${id} has no worktree branch`);
        return;
      }

      const strategy = options.strategy as MergeStrategy;
      const result = await mergeWorktree(task.worktreeBranch, strategy);

      if (isJsonOutput()) {
        printJson(result);
        return;
      }

      if (result.success) {
        printSuccess(result.message);

        if (options.cleanup && task.worktreePath) {
          try {
            await removeWorktree(task.worktreePath);
            printSuccess('Worktree cleaned up');
          } catch (err) {
            printError(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } else {
        printError(result.message);
      }
    });
}
