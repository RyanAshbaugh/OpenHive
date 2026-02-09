import { exec } from '../utils/process.js';
import { logger } from '../utils/logger.js';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
}

async function getRepoRoot(cwd?: string): Promise<string> {
  const result = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (result.exitCode !== 0) {
    throw new Error('Not in a git repository');
  }
  return result.stdout.trim();
}

export async function createWorktree(
  taskId: string,
  worktreeDir: string,
  cwd?: string,
): Promise<WorktreeInfo> {
  const repoRoot = await getRepoRoot(cwd);
  const branchName = `openhive/${taskId}`;
  const worktreePath = join(repoRoot, worktreeDir, taskId);

  // Create a new branch and worktree
  const result = await exec('git', ['worktree', 'add', '-b', branchName, worktreePath], {
    cwd: repoRoot,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Failed to create worktree: ${result.stderr}`);
  }

  // Get the HEAD commit
  const headResult = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
  const head = headResult.stdout.trim();

  logger.info(`Created worktree at ${worktreePath} on branch ${branchName}`);
  return { path: worktreePath, branch: branchName, head };
}

export async function listWorktrees(cwd?: string): Promise<WorktreeInfo[]> {
  let repoRoot: string;
  try {
    repoRoot = await getRepoRoot(cwd);
  } catch {
    return [];
  }
  const result = await exec('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot });

  if (result.exitCode !== 0) {
    return [];
  }

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) worktrees.push(current as WorktreeInfo);
      current = { path: line.slice(9) };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).replace('refs/heads/', '');
    }
  }
  if (current.path) worktrees.push(current as WorktreeInfo);

  return worktrees;
}

export async function getWorktreeDiff(worktreePath: string): Promise<string> {
  const result = await exec('git', ['diff', 'HEAD'], { cwd: worktreePath });
  return result.stdout;
}

export async function removeWorktree(
  worktreePath: string,
  cwd?: string,
): Promise<void> {
  const repoRoot = await getRepoRoot(cwd);

  // Get the branch name before removing
  const branchResult = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: worktreePath,
  });
  const branch = branchResult.stdout.trim();

  // Remove the worktree
  const result = await exec('git', ['worktree', 'remove', worktreePath, '--force'], {
    cwd: repoRoot,
  });

  if (result.exitCode !== 0) {
    // Fallback: just delete the directory and prune
    await rm(worktreePath, { recursive: true, force: true });
    await exec('git', ['worktree', 'prune'], { cwd: repoRoot });
  }

  // Delete the branch
  if (branch && branch.startsWith('openhive/')) {
    await exec('git', ['branch', '-D', branch], { cwd: repoRoot });
  }

  logger.info(`Removed worktree at ${worktreePath}`);
}
