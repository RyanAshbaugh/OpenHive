export type TaskStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  prompt: string;
  status: TaskStatus;
  agent?: string;
  projectId?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  contextFiles?: string[];
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export function createTask(prompt: string, id: string, options?: {
  agent?: string;
  projectId?: string;
  contextFiles?: string[];
}): Task {
  return {
    id,
    prompt,
    status: 'pending',
    agent: options?.agent,
    projectId: options?.projectId,
    contextFiles: options?.contextFiles,
    createdAt: new Date().toISOString(),
  };
}
