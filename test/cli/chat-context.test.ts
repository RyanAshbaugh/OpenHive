import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatContext } from '../../src/cli/commands/chat-context.js';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedMkdir = vi.mocked(mkdir);

describe('ChatContext', () => {
  let ctx: ChatContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockedWriteFile.mockResolvedValue(undefined);
    mockedMkdir.mockResolvedValue(undefined);
    ctx = new ChatContext('claude', '/tmp/test-session');
  });

  describe('buildPrompt', () => {
    it('returns just the message when there is no history', () => {
      const result = ctx.buildPrompt('hello');
      expect(result).toBe('hello');
    });

    it('includes conversation history when turns exist', async () => {
      await ctx.appendTurn('user', 'first question');
      await ctx.appendTurn('assistant', 'first answer');

      const result = ctx.buildPrompt('follow up');

      expect(result).toContain('Here is our conversation so far:');
      expect(result).toContain('User: first question');
      expect(result).toContain('Assistant: first answer');
      expect(result).toContain('Now respond to this new message: follow up');
    });
  });

  describe('appendTurn', () => {
    it('adds turns to history', async () => {
      expect(ctx.turns).toHaveLength(0);

      await ctx.appendTurn('user', 'hello');
      expect(ctx.turns).toHaveLength(1);
      expect(ctx.turns[0]).toEqual({ role: 'user', content: 'hello' });

      await ctx.appendTurn('assistant', 'hi there');
      expect(ctx.turns).toHaveLength(2);
      expect(ctx.turns[1]).toEqual({ role: 'assistant', content: 'hi there' });
    });

    it('persists to disk after each append', async () => {
      await ctx.appendTurn('user', 'test');
      expect(mockedMkdir).toHaveBeenCalled();
      expect(mockedWriteFile).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('resets turns to empty', async () => {
      await ctx.appendTurn('user', 'a');
      await ctx.appendTurn('assistant', 'b');
      expect(ctx.turns).toHaveLength(2);

      await ctx.clear();
      expect(ctx.turns).toHaveLength(0);
    });
  });

  describe('switchAgent', () => {
    it('changes agent and clears history', async () => {
      await ctx.appendTurn('user', 'msg');
      expect(ctx.agent).toBe('claude');
      expect(ctx.turns).toHaveLength(1);

      await ctx.switchAgent('codex');
      expect(ctx.agent).toBe('codex');
      expect(ctx.turns).toHaveLength(0);
    });
  });

  describe('truncation', () => {
    it('keeps only the last 20 turns when exceeding the limit', async () => {
      for (let i = 0; i < 22; i++) {
        await ctx.appendTurn('user', `message ${i}`);
      }

      expect(ctx.turns).toHaveLength(20);
      expect(ctx.turns[0].content).toBe('message 2');
      expect(ctx.turns[19].content).toBe('message 21');
    });
  });

  describe('load', () => {
    it('returns false when the session file does not exist', async () => {
      mockedReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await ctx.load();
      expect(result).toBe(false);
    });

    it('returns true and restores session when file exists', async () => {
      const session = {
        agent: 'gemini',
        turns: [{ role: 'user', content: 'saved message' }],
        createdAt: '2025-01-01T00:00:00.000Z',
      };
      mockedReadFile.mockResolvedValue(JSON.stringify(session));

      const result = await ctx.load();
      expect(result).toBe(true);
      expect(ctx.agent).toBe('gemini');
      expect(ctx.turns).toHaveLength(1);
      expect(ctx.turns[0].content).toBe('saved message');
    });
  });
});
