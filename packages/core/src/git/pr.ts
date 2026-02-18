/**
 * GitHub PR creation via the `gh` CLI.
 * Stub for orchestrated workflows — not exercised by e2e tests yet.
 */

import { exec } from '../utils/process.js';
import { logger } from '../utils/logger.js';

export interface PrResult {
  success: boolean;
  url?: string;
  error?: string;
}

/**
 * Check if the GitHub CLI is installed and authenticated.
 */
export async function isGhAvailable(cwd?: string): Promise<boolean> {
  const result = await exec('gh', ['auth', 'status'], { cwd, timeout: 10_000 });
  return result.exitCode === 0;
}

/**
 * Create a pull request for the given branch.
 */
export async function createPullRequest(
  branch: string,
  title: string,
  body: string,
  cwd?: string,
): Promise<PrResult> {
  const result = await exec(
    'gh',
    ['pr', 'create', '--head', branch, '--title', title, '--body', body],
    { cwd, timeout: 30_000 },
  );

  if (result.exitCode !== 0) {
    logger.error(`Failed to create PR: ${result.stderr}`);
    return { success: false, error: result.stderr };
  }

  // gh pr create prints the PR URL on success
  const url = result.stdout.trim();
  logger.info(`Created PR: ${url}`);
  return { success: true, url };
}
