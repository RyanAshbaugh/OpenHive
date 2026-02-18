import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadFile, mockCapturePane, mockStripAnsi, mockStorageLoad } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockCapturePane: vi.fn(),
  mockStripAnsi: vi.fn((s: string) => s),
  mockStorageLoad: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
}));

vi.mock('../../src/orchestrator/tmux.js', () => ({
  capturePane: mockCapturePane,
  stripAnsi: mockStripAnsi,
}));

vi.mock('../../src/tasks/storage.js', () => ({
  TaskStorage: vi.fn().mockImplementation(() => ({
    load: mockStorageLoad,
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

import {
  readTmuxPane,
  readTaskLog,
  gatherContext,
} from '../../src/cli/context-sources.js';

describe('context-sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('readTmuxPane', () => {
    it('captures and strips ANSI from pane content', async () => {
      mockCapturePane.mockResolvedValue('  \x1b[32msome output\x1b[0m  ');
      mockStripAnsi.mockReturnValue('some output');

      const result = await readTmuxPane('session:0.1');

      expect(mockCapturePane).toHaveBeenCalledWith('session:0.1', -100);
      expect(mockStripAnsi).toHaveBeenCalled();
      expect(result).toBe('some output');
    });
  });

  describe('readTaskLog', () => {
    it('throws for unknown task', async () => {
      mockStorageLoad.mockResolvedValue(null);

      await expect(readTaskLog('nonexistent', '/tmp/tasks')).rejects.toThrow(
        'Task nonexistent not found',
      );
    });

    it('returns combined stdout and stderr', async () => {
      mockStorageLoad.mockResolvedValue({
        id: 'task-1',
        status: 'completed',
        stdout: 'standard output',
        stderr: 'error output',
        prompt: 'do stuff',
        createdAt: '2025-01-01T00:00:00.000Z',
      });

      const result = await readTaskLog('task-1', '/tmp/tasks');
      expect(result).toBe('standard output\nerror output');
    });

    it('returns error field when present', async () => {
      mockStorageLoad.mockResolvedValue({
        id: 'task-2',
        status: 'failed',
        error: 'something broke',
        prompt: 'do stuff',
        createdAt: '2025-01-01T00:00:00.000Z',
      });

      const result = await readTaskLog('task-2', '/tmp/tasks');
      expect(result).toBe('Error: something broke');
    });

    it('returns no-output message when task has no output fields', async () => {
      mockStorageLoad.mockResolvedValue({
        id: 'task-3',
        status: 'completed',
        prompt: 'do stuff',
        createdAt: '2025-01-01T00:00:00.000Z',
      });

      const result = await readTaskLog('task-3', '/tmp/tasks');
      expect(result).toBe('Task task-3 (status: completed) — no output recorded.');
    });
  });

  describe('gatherContext', () => {
    it('returns empty string with empty options', async () => {
      const result = await gatherContext({});
      expect(result).toBe('');
    });

    it('includes stdin section when stdinText is provided', async () => {
      const result = await gatherContext({ stdinText: 'piped input' });

      expect(result).toContain('[stdin]');
      expect(result).toContain('piped input');
      expect(result).toContain('[/stdin]');
    });

    it('does not include stdin section when stdinText is null', async () => {
      const result = await gatherContext({ stdinText: null });
      expect(result).toBe('');
    });

    it('includes file content sections', async () => {
      mockReadFile.mockResolvedValueOnce('file one content');
      mockReadFile.mockResolvedValueOnce('file two content');

      const result = await gatherContext({
        files: ['/path/to/a.txt', '/path/to/b.txt'],
      });

      expect(result).toContain('[file: /path/to/a.txt]');
      expect(result).toContain('file one content');
      expect(result).toContain('[/file]');
      expect(result).toContain('[file: /path/to/b.txt]');
      expect(result).toContain('file two content');
    });

    it('handles file read errors gracefully', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));

      const result = await gatherContext({ files: ['/missing/file.txt'] });

      expect(result).toContain('[file: /missing/file.txt]');
      expect(result).toContain('failed to read');
    });

    it('includes tmux pane section', async () => {
      mockCapturePane.mockResolvedValue('$ npm test\nall passed');
      mockStripAnsi.mockReturnValue('$ npm test\nall passed');

      const result = await gatherContext({ tmuxTarget: 'hive:0.2' });

      expect(result).toContain('[tmux: hive:0.2]');
      expect(result).toContain('$ npm test\nall passed');
      expect(result).toContain('[/tmux]');
    });

    it('includes task log section', async () => {
      mockStorageLoad.mockResolvedValue({
        id: 'abc123',
        status: 'completed',
        stdout: 'task output here',
        prompt: 'do stuff',
        createdAt: '2025-01-01T00:00:00.000Z',
      });

      const result = await gatherContext({
        taskId: 'abc123',
        storageDir: '/tmp/tasks',
      });

      expect(result).toContain('[task: abc123]');
      expect(result).toContain('task output here');
      expect(result).toContain('[/task]');
    });

    it('combines multiple sources with section headers', async () => {
      mockReadFile.mockResolvedValueOnce('readme contents');
      mockCapturePane.mockResolvedValue('pane output');
      mockStripAnsi.mockReturnValue('pane output');
      mockStorageLoad.mockResolvedValue({
        id: 't-1',
        status: 'completed',
        stdout: 'task log',
        prompt: 'do stuff',
        createdAt: '2025-01-01T00:00:00.000Z',
      });

      const result = await gatherContext({
        stdinText: 'stdin data',
        files: ['README.md'],
        tmuxTarget: 'main:0.0',
        taskId: 't-1',
        storageDir: '/tmp',
      });

      // All four sections present in order
      expect(result).toContain('[stdin]');
      expect(result).toContain('[file: README.md]');
      expect(result).toContain('[tmux: main:0.0]');
      expect(result).toContain('[task: t-1]');

      // Sections separated by double newlines
      const sections = result.split('\n\n');
      expect(sections.length).toBeGreaterThanOrEqual(4);

      // Verify ordering: stdin before file before tmux before task
      const stdinIdx = result.indexOf('[stdin]');
      const fileIdx = result.indexOf('[file: README.md]');
      const tmuxIdx = result.indexOf('[tmux: main:0.0]');
      const taskIdx = result.indexOf('[task: t-1]');
      expect(stdinIdx).toBeLessThan(fileIdx);
      expect(fileIdx).toBeLessThan(tmuxIdx);
      expect(tmuxIdx).toBeLessThan(taskIdx);
    });

    it('handles task log error gracefully in gatherContext', async () => {
      mockStorageLoad.mockResolvedValue(null);

      const result = await gatherContext({
        taskId: 'missing',
        storageDir: '/tmp',
      });

      expect(result).toContain('[task: missing]');
      expect(result).toContain('failed to read');
    });
  });
});
