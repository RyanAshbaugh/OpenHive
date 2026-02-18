import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRegistry } from '../../src/agents/registry.js';
import type { OpenHiveConfig } from '../../src/config/schema.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// Mock commandExists to control availability
vi.mock('../../src/utils/process.js', () => ({
  commandExists: vi.fn(async (cmd: string) => {
    return cmd === 'claude'; // Only claude is "installed"
  }),
}));

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  it('should have built-in adapters', () => {
    const adapters = registry.getAll();
    expect(adapters.length).toBe(4);
    expect(adapters.map(a => a.name)).toContain('claude');
    expect(adapters.map(a => a.name)).toContain('codex');
    expect(adapters.map(a => a.name)).toContain('gemini');
    expect(adapters.map(a => a.name)).toContain('cursor');
  });

  it('should get adapter by name', () => {
    const claude = registry.get('claude');
    expect(claude).toBeDefined();
    expect(claude!.name).toBe('claude');
    expect(claude!.provider).toBe('anthropic');
  });

  it('should return undefined for unknown adapter', () => {
    expect(registry.get('unknown')).toBeUndefined();
  });

  it('should check availability of all agents', async () => {
    const statuses = await registry.checkAll(DEFAULT_CONFIG);

    expect(statuses.length).toBe(4);

    const claudeStatus = statuses.find(s => s.adapter.name === 'claude');
    expect(claudeStatus!.available).toBe(true);
    expect(claudeStatus!.enabled).toBe(true);

    const codexStatus = statuses.find(s => s.adapter.name === 'codex');
    expect(codexStatus!.available).toBe(false);
    expect(codexStatus!.enabled).toBe(true);

    // Cursor is enabled by default but 'agent' command not installed
    const cursorStatus = statuses.find(s => s.adapter.name === 'cursor');
    expect(cursorStatus!.available).toBe(false);
    expect(cursorStatus!.enabled).toBe(true);
  });

  it('should return only available agents', async () => {
    await registry.checkAll(DEFAULT_CONFIG);
    const available = registry.getAvailable(DEFAULT_CONFIG);

    expect(available.length).toBe(1);
    expect(available[0].name).toBe('claude');
  });

  it('should allow registering custom adapters', () => {
    const custom = {
      name: 'custom',
      displayName: 'Custom Agent',
      provider: 'custom',
      command: 'custom-agent',
      supportedModes: ['pipe' as const],
      capabilities: { vision: false, streaming: false, headless: true },
      checkAvailability: async () => true,
      buildCommand: () => ({ command: 'custom-agent', args: [] }),
      spawn: vi.fn(),
      run: vi.fn(),
    };

    registry.register(custom);
    expect(registry.get('custom')).toBeDefined();
    expect(registry.getAll().length).toBe(5);
  });
});
