/**
 * Branch merge and file verification helpers for e2e tests.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { git, readTestFile } from './test-repo.js';

export interface MergeAllResult {
  success: boolean;
  merged: string[];
  failed: Array<{ branch: string; error: string }>;
}

/**
 * Merge all branches into the current branch (typically main).
 * Uses regular merge with auto-commit for each branch.
 */
export async function mergeAllBranches(
  repoRoot: string,
  branches: string[],
): Promise<MergeAllResult> {
  const merged: string[] = [];
  const failed: Array<{ branch: string; error: string }> = [];

  for (const branch of branches) {
    try {
      await git(repoRoot, 'merge', branch, '-m', `merge ${branch}`, '--no-edit');
      merged.push(branch);
    } catch (err: any) {
      failed.push({ branch, error: err.message ?? String(err) });
      // Abort failed merge so we can try the next one
      try {
        await git(repoRoot, 'merge', '--abort');
      } catch {
        // Already clean
      }
    }
  }

  return {
    success: failed.length === 0,
    merged,
    failed,
  };
}

export interface FileExpectation {
  /** Path relative to repo root */
  path: string;
  /** If provided, file contents must include this substring */
  contains?: string;
  /** If provided, file contents must match this regex */
  matches?: RegExp;
}

export interface VerifyResult {
  passed: boolean;
  details: Array<{
    path: string;
    exists: boolean;
    contentOk: boolean;
    message: string;
  }>;
}

/**
 * Verify files exist and optionally match content expectations.
 */
export async function verifyFiles(
  repoRoot: string,
  expectations: FileExpectation[],
): Promise<VerifyResult> {
  const details: VerifyResult['details'] = [];

  for (const exp of expectations) {
    const fullPath = join(repoRoot, exp.path);
    let exists = false;
    let contentOk = true;
    let message = '';

    try {
      await access(fullPath);
      exists = true;
    } catch {
      exists = false;
      contentOk = false;
      message = `File not found: ${exp.path}`;
      details.push({ path: exp.path, exists, contentOk, message });
      continue;
    }

    try {
      const content = await readTestFile(repoRoot, exp.path);

      if (exp.contains && !content.includes(exp.contains)) {
        contentOk = false;
        message = `File ${exp.path} missing expected substring: "${exp.contains}"`;
      } else if (exp.matches && !exp.matches.test(content)) {
        contentOk = false;
        message = `File ${exp.path} does not match expected pattern: ${exp.matches}`;
      } else {
        message = 'OK';
      }
    } catch (err: any) {
      contentOk = false;
      message = `Error reading ${exp.path}: ${err.message}`;
    }

    details.push({ path: exp.path, exists, contentOk, message });
  }

  return {
    passed: details.every(d => d.exists && d.contentOk),
    details,
  };
}
