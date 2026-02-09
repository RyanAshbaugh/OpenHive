import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the process utility
vi.mock('../../src/utils/process.js', () => ({
  exec: vi.fn(),
  commandExists: vi.fn(),
}));

import { exec } from '../../src/utils/process.js';

const mockExec = vi.mocked(exec);

describe('Worktree operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should detect git repo root', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '/home/user/project\n',
      stderr: '',
      exitCode: 0,
    });

    // Import after mocking
    const { listWorktrees } = await import('../../src/git/worktree.js');

    mockExec.mockResolvedValueOnce({
      stdout: 'worktree /home/user/project\nHEAD abc123\nbranch refs/heads/main\n',
      stderr: '',
      exitCode: 0,
    });

    const worktrees = await listWorktrees('/home/user/project');
    expect(worktrees.length).toBe(1);
    expect(worktrees[0].path).toBe('/home/user/project');
    expect(worktrees[0].branch).toBe('main');
  });

  it('should fail gracefully when not in git repo', async () => {
    mockExec.mockResolvedValueOnce({
      stdout: '',
      stderr: 'fatal: not a git repository',
      exitCode: 128,
    });

    const { listWorktrees } = await import('../../src/git/worktree.js');
    const worktrees = await listWorktrees('/tmp/not-a-repo');
    expect(worktrees).toEqual([]);
  });
});
