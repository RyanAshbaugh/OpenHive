import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Dispatcher } from '../../src/scheduler/dispatcher.js';
import { AgentRegistry } from '../../src/agents/registry.js';
import { PoolTracker } from '../../src/pool/tracker.js';
import { DEFAULT_CONFIG } from '../../src/config/defaults.js';
import { createTask } from '../../src/tasks/task.js';

// Mock commandExists
vi.mock('../../src/utils/process.js', () => ({
  commandExists: vi.fn(async (cmd: string) => {
    return cmd === 'claude' || cmd === 'codex';
  }),
}));

describe('Dispatcher', () => {
  let registry: AgentRegistry;
  let poolTracker: PoolTracker;
  let dispatcher: Dispatcher;

  beforeEach(async () => {
    registry = new AgentRegistry();
    poolTracker = new PoolTracker(DEFAULT_CONFIG.pools);
    dispatcher = new Dispatcher(registry, poolTracker, DEFAULT_CONFIG);

    // Check availability so registry knows what's installed
    await registry.checkAll(DEFAULT_CONFIG);
  });

  it('should select specified agent for task', () => {
    const task = createTask('test', 'id-1', { agent: 'claude' });
    const agent = dispatcher.selectAgent(task);
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('claude');
  });

  it('should return null for unavailable specified agent', () => {
    const task = createTask('test', 'id-1', { agent: 'gemini' });
    const agent = dispatcher.selectAgent(task);
    expect(agent).toBeNull();
  });

  it('should auto-select available agent when none specified', () => {
    const task = createTask('test', 'id-1');
    const agent = dispatcher.selectAgent(task);
    expect(agent).toBeDefined();
    // Should pick claude (first available)
    expect(agent!.name).toBe('claude');
  });

  it('should respect pool capacity', () => {
    // Fill up anthropic pool
    for (let i = 0; i < 5; i++) {
      poolTracker.recordDispatch('anthropic');
    }

    const task = createTask('test', 'id-1', { agent: 'claude' });
    const agent = dispatcher.selectAgent(task);
    expect(agent).toBeNull();
  });

  it('should fall back to next provider when first is at capacity', () => {
    // Fill up anthropic pool
    for (let i = 0; i < 5; i++) {
      poolTracker.recordDispatch('anthropic');
    }

    const task = createTask('test', 'id-1');
    const agent = dispatcher.selectAgent(task);
    // Should fall back to codex (openai)
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('codex');
  });

  it('should match multiple tasks to agents', () => {
    const tasks = [
      createTask('task 1', 'id-1'),
      createTask('task 2', 'id-2'),
      createTask('task 3', 'id-3'),
    ];

    const decisions = dispatcher.matchTasks(tasks);
    expect(decisions.length).toBe(3);
  });

  it('should respect default agent config', () => {
    const config = { ...DEFAULT_CONFIG, defaultAgent: 'codex' };
    const customDispatcher = new Dispatcher(registry, poolTracker, config);

    const task = createTask('test', 'id-1');
    const agent = customDispatcher.selectAgent(task);
    expect(agent!.name).toBe('codex');
  });
});
