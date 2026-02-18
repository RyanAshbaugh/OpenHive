import { describe, it, expect } from 'vitest';
import { buildLlmContext, parseLlmResponse } from '../../src/orchestrator/context.js';
import type { WorkerInfo, StateSnapshot, TaskAssignment } from '../../src/orchestrator/types.js';

describe('context', () => {
  describe('parseLlmResponse', () => {
    it('parses APPROVE meta-command', () => {
      const result = parseLlmResponse('APPROVE');
      expect(result).toEqual({ type: 'meta', command: 'APPROVE' });
    });

    it('parses WAIT meta-command', () => {
      const result = parseLlmResponse('WAIT');
      expect(result).toEqual({ type: 'meta', command: 'WAIT' });
    });

    it('parses RESTART meta-command', () => {
      const result = parseLlmResponse('RESTART');
      expect(result).toEqual({ type: 'meta', command: 'RESTART' });
    });

    it('parses DONE meta-command', () => {
      const result = parseLlmResponse('DONE');
      expect(result).toEqual({ type: 'meta', command: 'DONE' });
    });

    it('parses FAILED meta-command', () => {
      const result = parseLlmResponse('FAILED');
      expect(result).toEqual({ type: 'meta', command: 'FAILED' });
    });

    it('is case-insensitive for meta-commands', () => {
      expect(parseLlmResponse('approve')).toEqual({ type: 'meta', command: 'APPROVE' });
      expect(parseLlmResponse('Restart')).toEqual({ type: 'meta', command: 'RESTART' });
      expect(parseLlmResponse('  done  ')).toEqual({ type: 'meta', command: 'DONE' });
    });

    it('only checks first line for meta-commands', () => {
      const result = parseLlmResponse('APPROVE\nsome extra explanation');
      expect(result).toEqual({ type: 'meta', command: 'APPROVE' });
    });

    it('treats non-command text as literal', () => {
      const result = parseLlmResponse('Use the existing database schema');
      expect(result).toEqual({ type: 'text', text: 'Use the existing database schema' });
    });

    it('treats multi-line non-command text as literal', () => {
      const text = 'Use PostgreSQL for the database.\nCreate the users table first.';
      const result = parseLlmResponse(text);
      expect(result).toEqual({ type: 'text', text });
    });

    it('defaults to WAIT for empty response', () => {
      expect(parseLlmResponse('')).toEqual({ type: 'meta', command: 'WAIT' });
      expect(parseLlmResponse('  ')).toEqual({ type: 'meta', command: 'WAIT' });
    });

    it('trims whitespace from responses', () => {
      expect(parseLlmResponse('  APPROVE  ')).toEqual({ type: 'meta', command: 'APPROVE' });
      expect(parseLlmResponse('  hello world  ')).toEqual({ type: 'text', text: 'hello world' });
    });
  });

  describe('buildLlmContext', () => {
    const baseWorker: WorkerInfo = {
      id: 'test-1',
      tool: 'claude',
      tmuxTarget: 'openhive-orch:test-1',
      state: 'waiting_input',
      tasksCompleted: 0,
      pipeFile: '/nonexistent/pipe.log', // won't exist — falls back to paneOutput
      lastPipeSize: 0,
      lastCheckAt: Date.now(),
      lastOutputChangeAt: Date.now(),
      createdAt: Date.now(),
    };

    const baseSnapshot: StateSnapshot = {
      state: 'waiting_input',
      paneOutput: 'line 1\nline 2\nWhat database should I use?',
      timestamp: Date.now(),
    };

    const baseAssignment: TaskAssignment = {
      task: {
        id: 'task-1',
        prompt: 'Build a REST API with user authentication',
        status: 'running',
        createdAt: new Date().toISOString(),
      },
      assignedAt: Date.now(),
    };

    it('builds context with task prompt and pane output', async () => {
      const ctx = await buildLlmContext(baseWorker, baseSnapshot, baseAssignment, 40);

      expect(ctx.workerState).toBe('waiting_input');
      expect(ctx.taskPrompt).toBe('Build a REST API with user authentication');
      expect(ctx.paneOutputTail).toContain('What database should I use?');
      expect(ctx.prompt).toContain('waiting_input');
      expect(ctx.prompt).toContain('REST API');
      expect(ctx.prompt).toContain('What database should I use?');
    });

    it('builds context without task assignment', async () => {
      const ctx = await buildLlmContext(baseWorker, baseSnapshot, undefined, 40);

      expect(ctx.taskPrompt).toBeUndefined();
      expect(ctx.prompt).toContain('waiting_input');
      expect(ctx.prompt).toContain('What database should I use?');
      // Should not contain "Current Task" section
      expect(ctx.prompt).not.toContain('## Current Task');
    });

    it('falls back to pane output when pipe file does not exist', async () => {
      const ctx = await buildLlmContext(baseWorker, baseSnapshot, baseAssignment, 40);
      // Should use paneOutput since the pipe file doesn't exist
      expect(ctx.paneOutputTail).toContain('What database should I use?');
    });

    it('includes state explanation in prompt', async () => {
      const ctx = await buildLlmContext(baseWorker, baseSnapshot, baseAssignment, 40);
      expect(ctx.prompt).toContain('asking a question');
    });

    it('includes response instructions', async () => {
      const ctx = await buildLlmContext(baseWorker, baseSnapshot, baseAssignment, 40);
      expect(ctx.prompt).toContain('APPROVE');
      expect(ctx.prompt).toContain('WAIT');
      expect(ctx.prompt).toContain('RESTART');
      expect(ctx.prompt).toContain('DONE');
      expect(ctx.prompt).toContain('FAILED');
    });

    it('adjusts guidance based on state', async () => {
      const stuckSnapshot: StateSnapshot = {
        state: 'stuck',
        paneOutput: 'old output from a while ago',
        timestamp: Date.now(),
      };
      const stuckWorker = { ...baseWorker, state: 'stuck' as const };

      const ctx = await buildLlmContext(stuckWorker, stuckSnapshot, baseAssignment, 40);
      expect(ctx.prompt).toContain('stuck');
      expect(ctx.workerState).toBe('stuck');
    });
  });
});
