import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeWaves, runSpec, CycleError } from '../../src/specs/runner.js';
import type { TaskSpec, ProjectSpec } from '../../src/specs/schema.js';
import { TaskQueue } from '../../src/tasks/queue.js';
import { TaskStorage } from '../../src/tasks/storage.js';

describe('computeWaves', () => {
  it('should put all independent tasks in wave 1', () => {
    const tasks: TaskSpec[] = [
      { id: 'a', name: 'A', prompt: 'do a' },
      { id: 'b', name: 'B', prompt: 'do b' },
      { id: 'c', name: 'C', prompt: 'do c' },
    ];

    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(1);
    expect(waves[0].number).toBe(1);
    expect(waves[0].taskIds).toEqual(['a', 'b', 'c']);
  });

  it('should create sequential waves for a chain', () => {
    const tasks: TaskSpec[] = [
      { id: 'a', name: 'A', prompt: 'do a' },
      { id: 'b', name: 'B', prompt: 'do b', dependsOn: ['a'] },
      { id: 'c', name: 'C', prompt: 'do c', dependsOn: ['b'] },
    ];

    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(3);
    expect(waves[0].taskIds).toEqual(['a']);
    expect(waves[1].taskIds).toEqual(['b']);
    expect(waves[2].taskIds).toEqual(['c']);
  });

  it('should parallelize tasks with the same dependency', () => {
    const tasks: TaskSpec[] = [
      { id: 'root', name: 'Root', prompt: 'setup' },
      { id: 'a', name: 'A', prompt: 'do a', dependsOn: ['root'] },
      { id: 'b', name: 'B', prompt: 'do b', dependsOn: ['root'] },
    ];

    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(2);
    expect(waves[0].taskIds).toEqual(['root']);
    expect(waves[1].taskIds).toContain('a');
    expect(waves[1].taskIds).toContain('b');
  });

  it('should handle diamond dependencies', () => {
    const tasks: TaskSpec[] = [
      { id: 'root', name: 'Root', prompt: 'setup' },
      { id: 'left', name: 'Left', prompt: 'left', dependsOn: ['root'] },
      { id: 'right', name: 'Right', prompt: 'right', dependsOn: ['root'] },
      { id: 'join', name: 'Join', prompt: 'join', dependsOn: ['left', 'right'] },
    ];

    const waves = computeWaves(tasks);
    expect(waves).toHaveLength(3);
    expect(waves[0].taskIds).toEqual(['root']);
    expect(waves[1].taskIds).toContain('left');
    expect(waves[1].taskIds).toContain('right');
    expect(waves[2].taskIds).toEqual(['join']);
  });

  it('should detect cycles', () => {
    const tasks: TaskSpec[] = [
      { id: 'a', name: 'A', prompt: 'do a', dependsOn: ['b'] },
      { id: 'b', name: 'B', prompt: 'do b', dependsOn: ['a'] },
    ];

    expect(() => computeWaves(tasks)).toThrow(CycleError);
  });

  it('should detect larger cycles', () => {
    const tasks: TaskSpec[] = [
      { id: 'a', name: 'A', prompt: 'do a', dependsOn: ['c'] },
      { id: 'b', name: 'B', prompt: 'do b', dependsOn: ['a'] },
      { id: 'c', name: 'C', prompt: 'do c', dependsOn: ['b'] },
    ];

    expect(() => computeWaves(tasks)).toThrow(CycleError);
  });

  it('should handle expense tracker dependency graph', () => {
    const tasks: TaskSpec[] = [
      { id: 'scaffold', name: 'Scaffold', prompt: 'p' },
      { id: 'data-model', name: 'Data', prompt: 'p', dependsOn: ['scaffold'] },
      { id: 'auth', name: 'Auth', prompt: 'p', dependsOn: ['scaffold'] },
      { id: 'expense-api', name: 'API', prompt: 'p', dependsOn: ['data-model'] },
      { id: 'category-api', name: 'Cat API', prompt: 'p', dependsOn: ['data-model'] },
      { id: 'dashboard-ui', name: 'UI', prompt: 'p', dependsOn: ['expense-api'] },
      { id: 'expense-forms', name: 'Forms', prompt: 'p', dependsOn: ['expense-api', 'category-api'] },
      { id: 'auth-ui', name: 'Auth UI', prompt: 'p', dependsOn: ['auth'] },
      { id: 'tests', name: 'Tests', prompt: 'p', dependsOn: ['expense-api', 'category-api', 'auth'] },
    ];

    const waves = computeWaves(tasks);
    // Wave 1: scaffold
    // Wave 2: data-model, auth
    // Wave 3: expense-api, category-api, auth-ui (auth-ui only depends on auth which is wave 2)
    // Wave 4: dashboard-ui, expense-forms, tests
    expect(waves).toHaveLength(4);

    expect(waves[0].taskIds).toEqual(['scaffold']);
    expect(waves[1].taskIds).toContain('data-model');
    expect(waves[1].taskIds).toContain('auth');
    expect(waves[2].taskIds).toContain('expense-api');
    expect(waves[2].taskIds).toContain('category-api');
    expect(waves[2].taskIds).toContain('auth-ui');
    expect(waves[3].taskIds).toContain('dashboard-ui');
    expect(waves[3].taskIds).toContain('expense-forms');
    expect(waves[3].taskIds).toContain('tests');
  });
});

describe('runSpec', () => {
  it('should dispatch tasks in waves via scheduler', async () => {
    const spec: ProjectSpec = {
      name: 'Test',
      goal: 'Test',
      tasks: [
        { id: 'a', name: 'A', prompt: 'do a' },
        { id: 'b', name: 'B', prompt: 'do b', dependsOn: ['a'] },
      ],
    };

    const queue = new TaskQueue();
    const mockStorage = {
      save: vi.fn().mockResolvedValue(undefined),
      load: vi.fn(),
      loadAll: vi.fn(),
    } as any;

    const dispatchedTasks: string[] = [];
    const mockScheduler = {
      dispatchTask: vi.fn().mockImplementation(async (task: any) => {
        dispatchedTasks.push(task.prompt);
        // Simulate successful completion
        queue.update(task.id, { status: 'completed', completedAt: new Date().toISOString() });
      }),
    } as any;

    const result = await runSpec(spec, mockScheduler, queue, mockStorage);

    expect(result.success).toBe(true);
    expect(result.waves).toHaveLength(2);
    expect(result.waves[0].completed).toEqual(['a']);
    expect(result.waves[1].completed).toEqual(['b']);
    expect(dispatchedTasks).toEqual(['do a', 'do b']);
  });

  it('should stop on wave failure', async () => {
    const spec: ProjectSpec = {
      name: 'Test',
      goal: 'Test',
      tasks: [
        { id: 'a', name: 'A', prompt: 'do a' },
        { id: 'b', name: 'B', prompt: 'do b', dependsOn: ['a'] },
      ],
    };

    const queue = new TaskQueue();
    const mockStorage = { save: vi.fn().mockResolvedValue(undefined) } as any;

    const mockScheduler = {
      dispatchTask: vi.fn().mockImplementation(async (task: any) => {
        // Simulate failure for task 'a'
        queue.update(task.id, { status: 'failed', error: 'broke' });
      }),
    } as any;

    const result = await runSpec(spec, mockScheduler, queue, mockStorage);

    expect(result.success).toBe(false);
    expect(result.waves).toHaveLength(1); // Stopped after wave 1
    expect(result.waves[0].failed).toEqual(['a']);
  });
});
