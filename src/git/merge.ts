import { exec } from '../utils/process.js';
import { logger } from '../utils/logger.js';

export type MergeStrategy = 'merge' | 'squash' | 'rebase';

export interface MergeResult {
  success: boolean;
  message: string;
}

async function getRepoRoot(cwd?: string): Promise<string> {
  const result = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error('Not in a git repository');
  }
  return result.stdout.trim();
}

export async function mergeWorktree(
  branch: string,
  strategy: MergeStrategy = 'merge',
  cwd?: string,
): Promise<MergeResult> {
  const repoRoot = await getRepoRoot(cwd);

  let result;
  switch (strategy) {
    case 'squash':
      result = await exec('git', ['merge', '--squash', branch], { cwd: repoRoot });
      if (result.exitCode === 0) {
        const commitResult = await exec('git', ['commit', '-m', `[openhive] squash merge ${branch}`], {
          cwd: repoRoot,
        });
        if (commitResult.exitCode !== 0) {
          return { success: false, message: commitResult.stderr };
        }
      }
      break;
    case 'rebase':
      result = await exec('git', ['rebase', branch], { cwd: repoRoot });
      break;
    case 'merge':
    default:
      result = await exec('git', ['merge', branch, '-m', `[openhive] merge ${branch}`], {
        cwd: repoRoot,
      });
      break;
  }

  if (result.exitCode !== 0) {
    logger.error(`Merge failed: ${result.stderr}`);
    return { success: false, message: result.stderr };
  }

  logger.info(`Merged ${branch} using ${strategy} strategy`);
  return { success: true, message: `Merged ${branch} successfully` };
}
