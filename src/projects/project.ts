export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';

export interface Project {
  id: string;
  name: string;
  goal: string;
  taskIds: string[];
  status: ProjectStatus;
  orchestratorAgent?: string;
  createdAt: string;
  updatedAt: string;
}

export function createProject(id: string, name: string, goal: string, options?: {
  orchestratorAgent?: string;
}): Project {
  const now = new Date().toISOString();
  return {
    id,
    name,
    goal,
    taskIds: [],
    status: 'active',
    orchestratorAgent: options?.orchestratorAgent,
    createdAt: now,
    updatedAt: now,
  };
}
