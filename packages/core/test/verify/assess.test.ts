import { describe, it, expect, vi, beforeEach } from 'vitest';
import { findVisionAgent, assessScreenshot } from '../../src/verify/assess.js';
import { AgentRegistry } from '../../src/agents/registry.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';

// Mock commandExists so agents appear available
vi.mock('../../src/utils/process.js', () => ({
  commandExists: vi.fn(async (cmd: string) => {
    return cmd === 'claude' || cmd === 'gemini';
  }),
}));

describe('findVisionAgent', () => {
  let registry: AgentRegistry;

  beforeEach(async () => {
    registry = new AgentRegistry();
    await registry.checkAll(DEFAULT_CONFIG);
  });

  it('should prefer claude for vision assessment', () => {
    const agent = findVisionAgent(registry, DEFAULT_CONFIG);
    expect(agent).toBe('claude');
  });

  it('should fall back to gemini if claude is unavailable', async () => {
    // Create config with claude disabled
    const config = {
      ...DEFAULT_CONFIG,
      agents: {
        ...DEFAULT_CONFIG.agents,
        claude: { ...DEFAULT_CONFIG.agents.claude, enabled: false },
      },
    };
    const result = findVisionAgent(registry, config);
    expect(result).toBe('gemini');
  });

  it('should return null if no vision agents available', () => {
    const config = {
      ...DEFAULT_CONFIG,
      agents: Object.fromEntries(
        Object.entries(DEFAULT_CONFIG.agents).map(([k, v]) => [k, { ...v, enabled: false }])
      ),
    };
    const result = findVisionAgent(registry, config);
    expect(result).toBeNull();
  });
});

describe('assessScreenshot', () => {
  let registry: AgentRegistry;

  beforeEach(async () => {
    registry = new AgentRegistry();
    await registry.checkAll(DEFAULT_CONFIG);
  });

  it('should return failure when no vision agent is available', async () => {
    const config = {
      ...DEFAULT_CONFIG,
      agents: Object.fromEntries(
        Object.entries(DEFAULT_CONFIG.agents).map(([k, v]) => [k, { ...v, enabled: false }])
      ),
    };

    const result = await assessScreenshot({
      screenshotPath: '/tmp/test.png',
      url: 'http://localhost:3000',
      expectedDescription: 'A login page',
      registry,
      config,
    });

    expect(result.passed).toBe(false);
    expect(result.explanation).toContain('No vision-capable agent');
  });
});
