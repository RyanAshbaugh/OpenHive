import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFile, mockRun, mockAdapter } = vi.hoisted(() => {
  const mockExecFile = vi.fn();
  const mockRun = vi.fn();
  const mockAdapter = {
    name: 'claude',
    displayName: 'Claude Code',
    provider: 'anthropic',
    command: 'claude',
    supportedModes: ['pipe'],
    capabilities: { vision: true, streaming: true, headless: true },
    checkAvailability: vi.fn().mockResolvedValue(true),
    buildCommand: vi.fn(),
    spawn: vi.fn(),
    run: mockRun,
  };
  return { mockExecFile, mockRun, mockAdapter };
});

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));
vi.mock('node:util', () => ({
  promisify: () => mockExecFile,
}));

vi.mock('../../src/agents/registry.js', () => ({
  AgentRegistry: vi.fn().mockImplementation(() => ({
    get: (name: string) => (name === 'claude' ? mockAdapter : undefined),
    getAll: () => [mockAdapter],
  })),
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { buildFixPrompt, runWithSelfHealing } from '../../src/cli/commands/self-heal.js';

describe('self-heal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildFixPrompt', () => {
    it('includes error output in the prompt', () => {
      const prompt = buildFixPrompt('FAIL test.js\nAssertionError', 'stderr output');
      expect(prompt).toContain('test failure occurred');
      expect(prompt).toContain('AssertionError');
      expect(prompt).toContain('stderr output');
    });

    it('includes full output when under the limit', () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
      const prompt = buildFixPrompt(lines.join('\n'), '');
      expect(prompt).toContain('full error output');
      expect(prompt).toContain('line 0');
      expect(prompt).toContain('line 49');
    });

    it('truncates to last 500 lines and notes omission', () => {
      const lines = Array.from({ length: 800 }, (_, i) => `line ${i}`);
      const prompt = buildFixPrompt(lines.join('\n'), '');
      // Should contain the tail
      expect(prompt).toContain('line 799');
      expect(prompt).toContain('line 300');
      // Should not contain early lines
      expect(prompt).not.toContain('\nline 0\n');
      // Should note truncation with omitted count
      expect(prompt).toContain('300 earlier lines omitted');
      expect(prompt).toContain('check the full output');
    });

    it('includes instruction not to modify test files', () => {
      const prompt = buildFixPrompt('error', '');
      expect(prompt).toContain('Do not modify the test files');
    });
  });

  describe('runWithSelfHealing', () => {
    it('returns success on first try when tests pass', async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: 'All tests passed', stderr: '' });

      const result = await runWithSelfHealing({ cwd: '/tmp/test' });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('dispatches fix to agent on failure and retries', async () => {
      // First run: fail
      mockExecFile.mockRejectedValueOnce({
        stdout: 'FAIL: test broken',
        stderr: 'Error details',
        code: 1,
      });

      // Agent fix
      mockRun.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'Fixed the issue',
        stderr: '',
        durationMs: 5000,
      });

      // Second run: pass
      mockExecFile.mockResolvedValueOnce({ stdout: 'All tests passed', stderr: '' });

      const result = await runWithSelfHealing({ cwd: '/tmp/test' });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining('test failure occurred'),
          cwd: '/tmp/test',
        }),
      );
    });

    it('respects maxRetries', async () => {
      // All runs fail
      const failError = { stdout: 'FAIL', stderr: 'error', code: 1 };
      mockExecFile.mockRejectedValue(failError);
      mockRun.mockResolvedValue({
        exitCode: 0,
        stdout: 'attempted fix',
        stderr: '',
        durationMs: 1000,
      });

      const result = await runWithSelfHealing({
        cwd: '/tmp/test',
        maxRetries: 2,
      });

      expect(result.success).toBe(false);
      // 1 initial + 2 retries = 3 attempts
      expect(result.attempts).toBe(3);
      // Agent dispatched for each failure except the last
      expect(mockRun).toHaveBeenCalledTimes(2);
    });

    it('throws for unknown agent', async () => {
      await expect(
        runWithSelfHealing({ agent: 'unknown' }),
      ).rejects.toThrow('Unknown agent: unknown');
    });

    it('uses specified agent', async () => {
      mockExecFile.mockRejectedValueOnce({ stdout: 'FAIL', stderr: '', code: 1 });
      mockRun.mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'fix',
        stderr: '',
        durationMs: 1000,
      });
      mockExecFile.mockResolvedValueOnce({ stdout: 'pass', stderr: '' });

      const result = await runWithSelfHealing({
        cwd: '/tmp/test',
        agent: 'claude',
      });

      expect(result.success).toBe(true);
      expect(mockRun).toHaveBeenCalledTimes(1);
    });

    it('continues retrying even if agent fails', async () => {
      // Test fails
      mockExecFile.mockRejectedValueOnce({ stdout: 'FAIL', stderr: '', code: 1 });
      // Agent fails too
      mockRun.mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'agent error',
        durationMs: 1000,
      });
      // Test passes on retry
      mockExecFile.mockResolvedValueOnce({ stdout: 'pass', stderr: '' });

      const result = await runWithSelfHealing({ cwd: '/tmp/test' });

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });
  });
});
