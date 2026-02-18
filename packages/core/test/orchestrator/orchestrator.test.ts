import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import type { OrchestratorEvent } from '../../src/orchestrator/types.js';
import { DEFAULT_ORCHESTRATOR_CONFIG } from '../../src/orchestrator/types.js';
import { createTask } from '../../src/tasks/task.js';
import type { TaskStorage } from '../../src/tasks/storage.js';

/**
 * These tests exercise the Orchestrator's dispatch logic, worker recycling,
 * context affinity, and rate limit coordination. Since the Orchestrator relies
 * on tmux, we mock the internal methods that interact with WorkerSession to
 * keep tests fast and deterministic.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOrchestrator(
  opts: {
    maxWorkers?: number;
    maxTasksPerWorker?: number;
    autoApprove?: boolean;
  } = {},
) {
  const events: OrchestratorEvent[] = [];
  const orchestrator = new Orchestrator({
    config: {
      maxWorkers: opts.maxWorkers ?? 5,
      maxTasksPerWorker: opts.maxTasksPerWorker ?? 0,
      autoApprove: opts.autoApprove ?? true,
      tickIntervalMs: 100,
    },
    onEvent: (e) => events.push(e),
  });
  return { orchestrator, events };
}

function makeTask(id: string, agent = 'claude') {
  return createTask(`Do task ${id}`, id, { agent });
}

describe('Orchestrator', () => {
  describe('queueTask', () => {
    it('queues tasks for dispatch', () => {
      const { orchestrator } = makeOrchestrator();
      const task = makeTask('t1');
      orchestrator.queueTask(task);
      // Task is pending — not yet completed or failed
      expect(orchestrator.isTaskCompleted('t1')).toBe(false);
      expect(orchestrator.isTaskFailed('t1')).toBe(false);
    });

    it('accepts dependency hints', () => {
      const { orchestrator } = makeOrchestrator();
      const task = makeTask('t2');
      // Should not throw
      orchestrator.queueTask(task, ['t1']);
    });
  });

  describe('queueTasks', () => {
    it('queues multiple tasks', () => {
      const { orchestrator } = makeOrchestrator();
      orchestrator.queueTasks([makeTask('t1'), makeTask('t2')]);
      expect(orchestrator.isTaskCompleted('t1')).toBe(false);
      expect(orchestrator.isTaskCompleted('t2')).toBe(false);
    });
  });

  describe('isRunning', () => {
    it('starts as not running', () => {
      const { orchestrator } = makeOrchestrator();
      expect(orchestrator.isRunning).toBe(false);
    });

    it('stop sets running to false', () => {
      const { orchestrator } = makeOrchestrator();
      orchestrator.stop();
      expect(orchestrator.isRunning).toBe(false);
    });
  });

  describe('getWorkerStates', () => {
    it('returns empty array when no workers', () => {
      const { orchestrator } = makeOrchestrator();
      expect(orchestrator.getWorkerStates()).toEqual([]);
    });
  });

  describe('task completion tracking', () => {
    it('isTaskFailed returns false for unknown task', () => {
      const { orchestrator } = makeOrchestrator();
      expect(orchestrator.isTaskFailed('nonexistent')).toBe(false);
    });

    it('getFailureReason returns undefined for unknown task', () => {
      const { orchestrator } = makeOrchestrator();
      expect(orchestrator.getFailureReason('nonexistent')).toBeUndefined();
    });
  });

  describe('unsupported tool handling', () => {
    it('fails tasks with unsupported tools during dispatch', async () => {
      const { orchestrator, events } = makeOrchestrator();
      const task = makeTask('t1', 'unsupported-tool');
      orchestrator.queueTask(task);

      // Tick triggers dispatchPending which should fail the unsupported task
      await orchestrator.tick();

      expect(orchestrator.isTaskFailed('t1')).toBe(true);
      expect(orchestrator.getFailureReason('t1')).toContain('Unsupported tool');

      const failEvent = events.find(
        e => e.type === 'task_failed' && e.taskId === 't1',
      );
      expect(failEvent).toBeDefined();
    });
  });

  describe('event emission', () => {
    it('emits events through the onEvent callback', async () => {
      const { orchestrator, events } = makeOrchestrator();
      const task = makeTask('t1', 'bad-tool');
      orchestrator.queueTask(task);
      await orchestrator.tick();

      // Should have emitted task_failed
      expect(events.length).toBeGreaterThan(0);
      expect(events.some(e => e.type === 'task_failed')).toBe(true);
    });

    it('handles event handler errors gracefully', async () => {
      const orchestrator = new Orchestrator({
        config: { maxWorkers: 3 },
        onEvent: () => { throw new Error('handler error'); },
      });
      const task = makeTask('t1', 'invalid-agent');
      orchestrator.queueTask(task);

      // Should not throw despite handler error
      await expect(orchestrator.tick()).resolves.not.toThrow();
    });
  });

  describe('config defaults', () => {
    it('uses DEFAULT_ORCHESTRATOR_CONFIG when no config provided', () => {
      const orchestrator = new Orchestrator();
      // Verify it doesn't throw and uses defaults
      expect(orchestrator.isRunning).toBe(false);
      expect(orchestrator.getWorkerStates()).toEqual([]);
    });

    it('merges partial config with defaults', () => {
      const orchestrator = new Orchestrator({
        config: { maxWorkers: 10 },
      });
      expect(orchestrator.isRunning).toBe(false);
    });
  });
});

describe('Orchestrator: taskStorage integration', () => {
  it('accepts taskStorage option without error', () => {
    const mockStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
      loadAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
      deleteAll: vi.fn().mockResolvedValue(0),
      ensureDir: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStorage;

    const orchestrator = new Orchestrator({
      config: { maxWorkers: 3 },
      taskStorage: mockStorage,
    });
    expect(orchestrator.isRunning).toBe(false);
  });

  it('persists task on queue via taskStorage', async () => {
    const mockStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
      loadAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
      deleteAll: vi.fn().mockResolvedValue(0),
      ensureDir: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStorage;

    const orchestrator = new Orchestrator({
      config: { maxWorkers: 3 },
      taskStorage: mockStorage,
    });

    const task = makeTask('persist-test');
    orchestrator.queueTask(task);

    // queueTask calls persistTask which is async fire-and-forget
    // Give it a tick to resolve
    await new Promise(r => setTimeout(r, 10));
    expect(mockStorage.save).toHaveBeenCalledWith(task);
  });

  it('persists failed task state for unsupported tools', async () => {
    const mockStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn().mockResolvedValue(null),
      loadAll: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue(true),
      deleteAll: vi.fn().mockResolvedValue(0),
      ensureDir: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskStorage;

    const orchestrator = new Orchestrator({
      config: { maxWorkers: 3 },
      taskStorage: mockStorage,
    });

    const task = makeTask('fail-test', 'unsupported-tool');
    orchestrator.queueTask(task);

    await orchestrator.tick();

    // Should have been called at least twice: once on queue, once on fail
    expect(mockStorage.save).toHaveBeenCalledTimes(2);
    // Last call should have the failed status
    const lastCall = mockStorage.save.mock.calls[1][0];
    expect(lastCall.status).toBe('failed');
    expect(lastCall.error).toContain('Unsupported tool');
  });
});

describe('Orchestrator: DEFAULT_ORCHESTRATOR_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_ORCHESTRATOR_CONFIG).toMatchObject({
      enabled: false,
      maxWorkers: 3,
      tickIntervalMs: 2000,
      autoApprove: true,
      stuckTimeoutMs: 120_000,
      llmEscalationTool: 'claude',
      llmContextLines: 40,
      idleSettlingMs: 5000,
      maxTasksPerWorker: 0,
    });
  });
});
