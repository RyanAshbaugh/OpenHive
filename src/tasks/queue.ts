import type { Task, TaskStatus } from './task.js';

export class TaskQueue {
  private tasks = new Map<string, Task>();

  add(task: Task): void {
    this.tasks.set(task.id, task);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  update(id: string, updates: Partial<Task>): Task | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    const updated = { ...task, ...updates };
    this.tasks.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.tasks.delete(id);
  }

  list(): Task[] {
    return Array.from(this.tasks.values());
  }

  filter(predicate: (task: Task) => boolean): Task[] {
    return this.list().filter(predicate);
  }

  byStatus(status: TaskStatus): Task[] {
    return this.filter(t => t.status === status);
  }

  byProject(projectId: string): Task[] {
    return this.filter(t => t.projectId === projectId);
  }

  pending(): Task[] {
    return this.byStatus('pending');
  }

  running(): Task[] {
    return this.byStatus('running');
  }

  size(): number {
    return this.tasks.size;
  }

  clear(): void {
    this.tasks.clear();
  }

  loadAll(tasks: Task[]): void {
    for (const task of tasks) {
      this.tasks.set(task.id, task);
    }
  }
}
