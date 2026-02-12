import { describe, it, expect } from 'vitest';
import { ResponseEngine, _llmResponseToAction } from '../../src/orchestrator/response.js';
import { buildProfile } from '../../src/orchestrator/patterns.js';
import type { StateSnapshot, WorkerInfo, TaskAssignment, LlmResponse } from '../../src/orchestrator/types.js';

describe('ResponseEngine', () => {
  describe('Tier 1: decide() with autoApprove=true', () => {
    const profile = buildProfile('claude', true);
    const engine = new ResponseEngine(profile);

    const baseWorker: WorkerInfo = {
      id: 'test-1',
      tool: 'claude',
      tmuxTarget: 'openhive-orch:test-1',
      state: 'idle',
      tasksCompleted: 0,
      pipeFile: '/tmp/test.pipe',
      lastPipeSize: 0,
      lastCheckAt: Date.now(),
      lastOutputChangeAt: Date.now(),
      createdAt: Date.now(),
    };

    function makeSnapshot(state: string, paneOutput = ''): StateSnapshot {
      return {
        state: state as any,
        paneOutput,
        timestamp: Date.now(),
      };
    }

    it('approves when waiting_approval with autoApprove', () => {
      const action = engine.decide(
        makeSnapshot('waiting_approval', 'Do you want to run this?'),
        baseWorker,
      );
      expect(action.type).toBe('approve');
    });

    it('returns noop when working', () => {
      const action = engine.decide(
        makeSnapshot('working', 'Thinking...'),
        baseWorker,
      );
      expect(action.type).toBe('noop');
    });

    it('returns wait when rate_limited', () => {
      const action = engine.decide(
        makeSnapshot('rate_limited', 'rate limit exceeded'),
        baseWorker,
      );
      expect(action.type).toBe('wait');
      if (action.type === 'wait') {
        expect(action.durationMs).toBe(60_000);
      }
    });

    it('returns escalate_llm when waiting_input', () => {
      const assignment: TaskAssignment = {
        task: {
          id: 'task-1',
          prompt: 'Build a button component',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
        assignedAt: Date.now(),
      };

      const action = engine.decide(
        makeSnapshot('waiting_input', 'Which framework should I use?'),
        baseWorker,
        assignment,
      );
      expect(action.type).toBe('escalate_llm');
    });

    it('returns escalate_llm when stuck', () => {
      const action = engine.decide(
        makeSnapshot('stuck', 'old output'),
        baseWorker,
      );
      expect(action.type).toBe('escalate_llm');
    });

    it('returns restart when dead', () => {
      const action = engine.decide(
        makeSnapshot('dead'),
        baseWorker,
      );
      expect(action.type).toBe('restart');
    });

    it('returns dismiss when starting (startup dialog)', () => {
      const action = engine.decide(
        makeSnapshot('starting', 'Update available'),
        baseWorker,
      );
      expect(action.type).toBe('dismiss');
    });

    it('marks complete when idle with settled assignment', () => {
      const assignment: TaskAssignment = {
        task: {
          id: 'task-1',
          prompt: 'Do something',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
        assignedAt: Date.now() - 30_000,
        idleDetectedAt: Date.now() - 10_000,
      };

      const action = engine.decide(
        makeSnapshot('idle', '> '),
        baseWorker,
        assignment,
      );
      expect(action.type).toBe('mark_complete');
    });

    it('returns noop when idle with unsettled assignment', () => {
      const now = Date.now();
      const assignment: TaskAssignment = {
        task: {
          id: 'task-1',
          prompt: 'Do something',
          status: 'running',
          createdAt: new Date().toISOString(),
        },
        assignedAt: now - 30_000,
        idleDetectedAt: now - 1_000,
      };

      const snapshot = makeSnapshot('idle', '> ');
      snapshot.timestamp = now;

      const action = engine.decide(snapshot, baseWorker, assignment);
      expect(action.type).toBe('noop');
    });

    it('returns noop when idle with no assignment', () => {
      const action = engine.decide(
        makeSnapshot('idle', '> '),
        baseWorker,
      );
      expect(action.type).toBe('noop');
    });
  });

  describe('Tier 1: decide() with autoApprove=false', () => {
    const profile = buildProfile('claude', false);
    const engine = new ResponseEngine(profile);

    const baseWorker: WorkerInfo = {
      id: 'test-2',
      tool: 'claude',
      tmuxTarget: 'openhive-orch:test-2',
      state: 'idle',
      tasksCompleted: 0,
      pipeFile: '/tmp/test.pipe',
      lastPipeSize: 0,
      lastCheckAt: Date.now(),
      lastOutputChangeAt: Date.now(),
      createdAt: Date.now(),
    };

    it('escalates to LLM when waiting_approval', () => {
      const action = engine.decide(
        {
          state: 'waiting_approval',
          paneOutput: 'Do you want to run this command?',
          timestamp: Date.now(),
        },
        baseWorker,
      );
      expect(action.type).toBe('escalate_llm');
    });
  });

  describe('Tier 2: llmResponseToAction', () => {
    it('converts APPROVE to approve action', () => {
      const response: LlmResponse = { type: 'meta', command: 'APPROVE' };
      const action = _llmResponseToAction(response, 'waiting_approval');
      expect(action).toEqual({ type: 'approve' });
    });

    it('converts WAIT to wait action with 30s duration', () => {
      const response: LlmResponse = { type: 'meta', command: 'WAIT' };
      const action = _llmResponseToAction(response, 'working');
      expect(action.type).toBe('wait');
      if (action.type === 'wait') {
        expect(action.durationMs).toBe(30_000);
      }
    });

    it('converts RESTART to restart action', () => {
      const response: LlmResponse = { type: 'meta', command: 'RESTART' };
      const action = _llmResponseToAction(response, 'stuck');
      expect(action).toEqual({ type: 'restart' });
    });

    it('converts DONE to mark_complete action', () => {
      const response: LlmResponse = { type: 'meta', command: 'DONE' };
      const action = _llmResponseToAction(response, 'idle');
      expect(action).toEqual({ type: 'mark_complete' });
    });

    it('converts FAILED to mark_failed action', () => {
      const response: LlmResponse = { type: 'meta', command: 'FAILED' };
      const action = _llmResponseToAction(response, 'error');
      expect(action.type).toBe('mark_failed');
      if (action.type === 'mark_failed') {
        expect(action.reason).toContain('error');
      }
    });

    it('converts literal text to send_text action', () => {
      const response: LlmResponse = { type: 'text', text: 'Use PostgreSQL' };
      const action = _llmResponseToAction(response, 'waiting_input');
      expect(action).toEqual({ type: 'send_text', text: 'Use PostgreSQL' });
    });

    it('converts multi-line text to send_text action', () => {
      const text = 'First implement the database schema.\nThen create the API routes.';
      const response: LlmResponse = { type: 'text', text };
      const action = _llmResponseToAction(response, 'waiting_input');
      expect(action).toEqual({ type: 'send_text', text });
    });
  });
});
