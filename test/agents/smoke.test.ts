import { describe, it, expect } from 'vitest';
import { ClaudeAdapter } from '../../src/agents/adapters/claude.js';
import { CodexAdapter } from '../../src/agents/adapters/codex.js';
import { GeminiAdapter } from '../../src/agents/adapters/gemini.js';
import { CursorAdapter } from '../../src/agents/adapters/cursor.js';

/**
 * Smoke tests for agent providers.
 * These check that each adapter can detect availability and build correct commands.
 * Run with: pnpm test -- test/agents/smoke.test.ts
 */

describe('Agent Smoke Tests', () => {
  describe('Claude Code', () => {
    const adapter = new ClaudeAdapter();

    it('should have correct metadata', () => {
      expect(adapter.name).toBe('claude');
      expect(adapter.provider).toBe('anthropic');
      expect(adapter.supportedModes).toContain('pipe');
      expect(adapter.capabilities.vision).toBe(true);
    });

    it('should build correct command', () => {
      const { command, args } = adapter.buildCommand({
        prompt: 'hello world',
        cwd: '/tmp',
      });
      expect(command).toBe('claude');
      expect(args).toContain('-p');
      expect(args).toContain('hello world');
      expect(args).toContain('--output-format');
      expect(args).toContain('text');
    });

    it('should include context files in command', () => {
      const { args } = adapter.buildCommand({
        prompt: 'fix bug',
        cwd: '/tmp',
        contextFiles: ['screenshot.png', 'error.log'],
      });
      expect(args).toContain('--file');
      expect(args).toContain('screenshot.png');
      expect(args).toContain('error.log');
    });

    it('should detect availability', async () => {
      const available = await adapter.checkAvailability();
      // This will be true or false depending on environment
      expect(typeof available).toBe('boolean');
    });
  });

  describe('Codex CLI', () => {
    const adapter = new CodexAdapter();

    it('should have correct metadata', () => {
      expect(adapter.name).toBe('codex');
      expect(adapter.provider).toBe('openai');
    });

    it('should build correct command', () => {
      const { command, args } = adapter.buildCommand({
        prompt: 'hello world',
        cwd: '/tmp',
      });
      expect(command).toBe('codex');
      expect(args).toContain('--quiet');
      expect(args).toContain('hello world');
    });
  });

  describe('Gemini CLI', () => {
    const adapter = new GeminiAdapter();

    it('should have correct metadata', () => {
      expect(adapter.name).toBe('gemini');
      expect(adapter.provider).toBe('google');
      expect(adapter.capabilities.vision).toBe(true);
    });

    it('should build correct command', () => {
      const { command, args } = adapter.buildCommand({
        prompt: 'hello world',
        cwd: '/tmp',
      });
      expect(command).toBe('gemini');
      expect(args).toContain('-p');
      expect(args).toContain('hello world');
    });
  });

  describe('Cursor Agent', () => {
    const adapter = new CursorAdapter();

    it('should have correct metadata', () => {
      expect(adapter.name).toBe('cursor');
      expect(adapter.provider).toBe('cursor');
      expect(adapter.capabilities.headless).toBe(false);
    });

    it('should build correct command', () => {
      const { command, args } = adapter.buildCommand({
        prompt: 'hello world',
        cwd: '/tmp',
      });
      expect(command).toBe('agent');
      expect(args).toContain('--agent');
    });
  });
});
