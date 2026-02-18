/**
 * Temporary git repo lifecycle for e2e tests.
 * Creates isolated test repos with initial commits for worktree-based testing.
 */

import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface TestRepo {
  root: string;
  cleanup: () => Promise<void>;
}

/**
 * Run a git command in the specified directory.
 */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout: 15_000 });
  return stdout.trim();
}

/**
 * Create a fresh temp git repo suitable for e2e tests.
 * - Initializes git with a dummy user
 * - Creates an initial commit
 * - Creates the .openhive-worktrees directory
 */
export async function createTestRepo(prefix = 'openhive-e2e'): Promise<TestRepo> {
  const root = await mkdtemp(join(tmpdir(), `${prefix}-`));

  // Initialize git repo (disable GPG signing — test user has no key)
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'test@openhive.dev');
  await git(root, 'config', 'user.name', 'OpenHive Test');
  await git(root, 'config', 'commit.gpgsign', 'false');
  await git(root, 'config', 'tag.gpgsign', 'false');

  // Create initial commit (git worktree requires at least one commit)
  await execFileAsync('touch', [join(root, '.gitkeep')]);
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'initial commit');

  // Create worktree directory
  await mkdir(join(root, '.openhive-worktrees'), { recursive: true });

  return {
    root,
    cleanup: async () => {
      // Remove any worktrees first (git worktree prune)
      try {
        await git(root, 'worktree', 'prune');
      } catch {
        // Ignore — repo might already be partially cleaned
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Read a file from the test repo, returning its contents as a string.
 */
export async function readTestFile(repoRoot: string, filePath: string): Promise<string> {
  return readFile(join(repoRoot, filePath), 'utf-8');
}

/**
 * Force-commit any unstaged/staged changes in a worktree directory.
 * Returns the branch name. Useful after an agent finishes — ensures
 * all modifications are committed before merging.
 */
export async function forceCommitWorktree(worktreePath: string, message: string): Promise<string> {
  // Stage everything
  await git(worktreePath, 'add', '-A');

  // Check if there's anything to commit
  try {
    await git(worktreePath, 'diff', '--cached', '--quiet');
    // No changes staged — nothing to commit
  } catch {
    // diff --quiet exits non-zero when there are changes
    await git(worktreePath, 'commit', '-m', message);
  }

  return git(worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD');
}
