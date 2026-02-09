import { describe, it, expect, beforeEach } from 'vitest';
import { TaskQueue } from '../../src/tasks/queue.js';
import { createTask } from '../../src/tasks/task.js';

describe('TaskQueue', () => {
  let queue: TaskQueue;

  beforeEach(() => {
    queue = new TaskQueue();
  });

  it('should add and get tasks', () => {
    const task = createTask('test prompt', 'task-1');
    queue.add(task);

    expect(queue.get('task-1')).toEqual(task);
    expect(queue.size()).toBe(1);
  });

  it('should return undefined for unknown task', () => {
    expect(queue.get('nonexistent')).toBeUndefined();
  });

  it('should update tasks', () => {
    const task = createTask('test prompt', 'task-1');
    queue.add(task);

    const updated = queue.update('task-1', { status: 'running', agent: 'claude' });
    expect(updated!.status).toBe('running');
    expect(updated!.agent).toBe('claude');
    expect(queue.get('task-1')!.status).toBe('running');
  });

  it('should return undefined when updating nonexistent task', () => {
    expect(queue.update('nonexistent', { status: 'running' })).toBeUndefined();
  });

  it('should remove tasks', () => {
    const task = createTask('test prompt', 'task-1');
    queue.add(task);

    expect(queue.remove('task-1')).toBe(true);
    expect(queue.size()).toBe(0);
    expect(queue.remove('task-1')).toBe(false);
  });

  it('should list all tasks', () => {
    queue.add(createTask('task 1', 'id-1'));
    queue.add(createTask('task 2', 'id-2'));
    queue.add(createTask('task 3', 'id-3'));

    expect(queue.list().length).toBe(3);
  });

  it('should filter tasks by status', () => {
    const t1 = createTask('task 1', 'id-1');
    const t2 = createTask('task 2', 'id-2');
    queue.add(t1);
    queue.add(t2);
    queue.update('id-1', { status: 'running' });

    expect(queue.byStatus('pending').length).toBe(1);
    expect(queue.byStatus('running').length).toBe(1);
    expect(queue.pending().length).toBe(1);
    expect(queue.running().length).toBe(1);
  });

  it('should filter tasks by project', () => {
    const t1 = createTask('task 1', 'id-1', { projectId: 'proj-1' });
    const t2 = createTask('task 2', 'id-2', { projectId: 'proj-2' });
    const t3 = createTask('task 3', 'id-3', { projectId: 'proj-1' });
    queue.add(t1);
    queue.add(t2);
    queue.add(t3);

    expect(queue.byProject('proj-1').length).toBe(2);
    expect(queue.byProject('proj-2').length).toBe(1);
  });

  it('should clear all tasks', () => {
    queue.add(createTask('task 1', 'id-1'));
    queue.add(createTask('task 2', 'id-2'));
    queue.clear();

    expect(queue.size()).toBe(0);
  });

  it('should load tasks in bulk', () => {
    const tasks = [
      createTask('task 1', 'id-1'),
      createTask('task 2', 'id-2'),
    ];
    queue.loadAll(tasks);

    expect(queue.size()).toBe(2);
    expect(queue.get('id-1')).toBeDefined();
  });
});
