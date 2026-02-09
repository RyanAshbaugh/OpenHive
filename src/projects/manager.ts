import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Project } from './project.js';
import { createProject } from './project.js';
import { generateId } from '../utils/id.js';
import { logger } from '../utils/logger.js';

export class ProjectManager {
  private projects = new Map<string, Project>();

  constructor(private storageDir: string) {}

  private projectPath(id: string): string {
    return join(this.storageDir, `${id}.json`);
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
  }

  create(name: string, goal: string, options?: { orchestratorAgent?: string }): Project {
    const project = createProject(generateId(), name, goal, options);
    this.projects.set(project.id, project);
    return project;
  }

  get(id: string): Project | undefined {
    return this.projects.get(id);
  }

  list(): Project[] {
    return Array.from(this.projects.values());
  }

  addTask(projectId: string, taskId: string): void {
    const project = this.projects.get(projectId);
    if (project) {
      project.taskIds.push(taskId);
      project.updatedAt = new Date().toISOString();
    }
  }

  updateStatus(projectId: string, status: Project['status']): void {
    const project = this.projects.get(projectId);
    if (project) {
      project.status = status;
      project.updatedAt = new Date().toISOString();
    }
  }

  async save(project: Project): Promise<void> {
    await this.ensureDir();
    await writeFile(this.projectPath(project.id), JSON.stringify(project, null, 2), 'utf-8');
    logger.debug(`Saved project ${project.id}`);
  }

  async load(id: string): Promise<Project | null> {
    try {
      const content = await readFile(this.projectPath(id), 'utf-8');
      const project = JSON.parse(content) as Project;
      this.projects.set(project.id, project);
      return project;
    } catch {
      return null;
    }
  }

  async loadAll(): Promise<Project[]> {
    try {
      await this.ensureDir();
      const files = await readdir(this.storageDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const content = await readFile(join(this.storageDir, file), 'utf-8');
          const project = JSON.parse(content) as Project;
          this.projects.set(project.id, project);
        } catch {
          logger.warn(`Failed to load project file: ${file}`);
        }
      }
      return this.list();
    } catch {
      return [];
    }
  }
}
