import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task } from './task.js';
import { logger } from '../utils/logger.js';

export class TaskStorage {
  constructor(private storageDir: string) {}

  private taskPath(id: string): string {
    return join(this.storageDir, `${id}.json`);
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
  }

  async save(task: Task): Promise<void> {
    await this.ensureDir();
    await writeFile(this.taskPath(task.id), JSON.stringify(task, null, 2), 'utf-8');
    logger.debug(`Saved task ${task.id}`);
  }

  async load(id: string): Promise<Task | null> {
    try {
      const content = await readFile(this.taskPath(id), 'utf-8');
      return JSON.parse(content) as Task;
    } catch {
      return null;
    }
  }

  async loadAll(): Promise<Task[]> {
    try {
      await this.ensureDir();
      const files = await readdir(this.storageDir);
      const tasks: Task[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(join(this.storageDir, file), 'utf-8');
          tasks.push(JSON.parse(content) as Task);
        } catch {
          logger.warn(`Failed to load task file: ${file}`);
        }
      }
      return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch {
      return [];
    }
  }
}
