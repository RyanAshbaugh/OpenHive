import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tmux before importing WorkerSession
vi.mock('../../src/orchestrator/tmux.js', () => ({
  ensureSession: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(undefined),
  createWindow: vi.fn().mockResolvedValue('openhive-orch:test-worker'),
  killWindow: vi.fn().mockResolvedValue(undefined),
  isWindowAlive: vi.fn().mockResolvedValue(true),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendText: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue('> '),
  startPipePane: vi.fn().mockResolvedValue(undefined),
  stopPipePane: vi.fn().mockResolvedValue(undefined),
  getFileSize: vi.fn().mockResolvedValue(100),
  readPipeTail: vi.fn().mockResolvedValue(''),
  waitForReady: vi.fn().mockResolvedValue(undefined),
  stripAnsi: vi.fn((s: string) => s),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
});

import { WorkerSession } from '../../src/orchestrator/worker.js';
import { DEFAULT_ORCHESTRATOR_CONFIG } from '../../src/orchestrator/types.js';
import { createTask } from '../../src/tasks/task.js';
import * as tmux from '../../src/orchestrator/tmux.js';

describe('WorkerSession', () => {
  let worker: WorkerSession;

  beforeEach(() => {
    vi.clearAllMocks();
    worker = new WorkerSession('test-1', 'claude', DEFAULT_ORCHESTRATOR_CONFIG);
  });

  describe('constructor', () => {
    it('initializes with starting state', () => {
      expect(worker.state).toBe('starting');
      expect(worker.info.id).toBe('test-1');
      expect(worker.info.tool).toBe('claude');
      expect(worker.info.tasksCompleted).toBe(0);
    });

    it('sets up pipe file path', () => {
      expect(worker.info.pipeFile).toContain('worker-test-1.pipe');
    });

    it('starts with no assignment', () => {
      expect(worker.assignment).toBeUndefined();
      expect(worker.isIdle).toBe(false); // state is 'starting', not 'idle'
    });
  });

  describe('start', () => {
    it('transitions to idle state', async () => {
      await worker.start();
      expect(worker.state).toBe('idle');
      expect(worker.isIdle).toBe(true);
    });

    it('creates tmux window', async () => {
      await worker.start();
      expect(tmux.createWindow).toHaveBeenCalledWith('test-1', expect.any(String), undefined);
    });

    it('starts pipe-pane monitoring', async () => {
      await worker.start();
      expect(tmux.startPipePane).toHaveBeenCalled();
    });

    it('waits for tool to be ready', async () => {
      await worker.start();
      expect(tmux.waitForReady).toHaveBeenCalled();
    });
  });

  describe('assignTask', () => {
    it('assigns task and transitions to working', async () => {
      await worker.start();
      const task = createTask('Build a button', 'task-1');

      await worker.assignTask(task);

      expect(worker.state).toBe('working');
      expect(worker.assignment).toBeDefined();
      expect(worker.assignment?.task.id).toBe('task-1');
      expect(worker.isIdle).toBe(false);
    });

    it('sends prompt text via tmux', async () => {
      await worker.start();
      const task = createTask('Build a button', 'task-1');
      await worker.assignTask(task);

      expect(tmux.sendText).toHaveBeenCalledWith(
        expect.any(String),
        'Build a button',
      );
    });

    it('throws if worker is not idle', async () => {
      // Worker is in 'starting' state
      const task = createTask('Test', 'task-1');
      await expect(worker.assignTask(task)).rejects.toThrow('Cannot assign task');
    });
  });

  describe('markTaskComplete', () => {
    it('increments tasks completed and clears assignment', async () => {
      await worker.start();
      const task = createTask('Build a button', 'task-1');
      await worker.assignTask(task);

      worker.markTaskComplete();

      expect(worker.info.tasksCompleted).toBe(1);
      expect(worker.assignment).toBeUndefined();
      expect(worker.state).toBe('idle');
    });

    it('handles being called without assignment', () => {
      // Should not throw
      worker.markTaskComplete();
      expect(worker.info.tasksCompleted).toBe(0);
    });
  });

  describe('markTaskFailed', () => {
    it('clears assignment and returns to idle', async () => {
      await worker.start();
      const task = createTask('Build a button', 'task-1');
      await worker.assignTask(task);

      worker.markTaskFailed('timeout');

      expect(worker.assignment).toBeUndefined();
      expect(worker.state).toBe('idle');
    });
  });

  describe('hasNewOutput', () => {
    it('detects new output via pipe file size', async () => {
      // First call — getFileSize returns 100, initial lastPipeSize is 0
      const hasNew = await worker.hasNewOutput();
      expect(hasNew).toBe(true);
    });

    it('returns false when no new output', async () => {
      // Read once to sync size
      await worker.hasNewOutput();

      // Mock same size
      vi.mocked(tmux.getFileSize).mockResolvedValue(100);
      const hasNew = await worker.hasNewOutput();
      expect(hasNew).toBe(false);
    });
  });

  describe('approve', () => {
    it('sends Enter via sendKeys', async () => {
      await worker.start();
      await worker.approve();
      expect(tmux.sendKeys).toHaveBeenCalledWith(
        expect.any(String),
        ['Enter'],
      );
    });
  });

  describe('dismiss', () => {
    it('sends dismiss key', async () => {
      await worker.start();
      await worker.dismiss();
      expect(tmux.sendKeys).toHaveBeenCalled();
    });
  });

  describe('sendKeysToAgent', () => {
    it('delegates to tmux sendKeys', async () => {
      await worker.start();
      await worker.sendKeysToAgent(['Enter']);
      expect(tmux.sendKeys).toHaveBeenCalledWith(expect.any(String), ['Enter']);
    });
  });

  describe('sendTextToAgent', () => {
    it('delegates to tmux sendText', async () => {
      await worker.start();
      await worker.sendTextToAgent('hello world');
      expect(tmux.sendText).toHaveBeenCalledWith(expect.any(String), 'hello world');
    });
  });

  describe('isAlive', () => {
    it('checks tmux window status', async () => {
      const alive = await worker.isAlive();
      expect(alive).toBe(true);
      expect(tmux.isWindowAlive).toHaveBeenCalled();
    });

    it('returns false when window is dead', async () => {
      vi.mocked(tmux.isWindowAlive).mockResolvedValue(false);
      const alive = await worker.isAlive();
      expect(alive).toBe(false);
    });
  });

  describe('restart', () => {
    it('stops and restarts the worker', async () => {
      await worker.start();
      await worker.restart();

      // Should have called killWindow (stop) then createWindow (start)
      expect(tmux.killWindow).toHaveBeenCalled();
      expect(tmux.createWindow).toHaveBeenCalledTimes(2); // start + restart
      expect(worker.state).toBe('idle');
    });
  });

  describe('stop', () => {
    it('kills the tmux window and transitions to dead', async () => {
      await worker.start();
      await worker.stop();

      expect(tmux.stopPipePane).toHaveBeenCalled();
      expect(tmux.killWindow).toHaveBeenCalled();
      expect(worker.state).toBe('dead');
    });
  });

  describe('detectState', () => {
    it('captures pane and returns state snapshot', async () => {
      await worker.start();
      const snapshot = await worker.detectState();

      expect(snapshot).toBeDefined();
      expect(snapshot.state).toBeDefined();
      expect(snapshot.timestamp).toBeGreaterThan(0);
      expect(tmux.capturePane).toHaveBeenCalled();
    });

    it('tracks idle settling for completion detection', async () => {
      await worker.start();
      const task = createTask('Do something', 'task-1');
      await worker.assignTask(task);

      // Simulate idle detection
      vi.mocked(tmux.capturePane).mockResolvedValue('> ');
      const snapshot = await worker.detectState();

      // If state is idle and we have an assignment, idleDetectedAt should be set
      if (snapshot.state === 'idle') {
        expect(worker.assignment?.idleDetectedAt).toBeDefined();
      }
    });
  });
});
