import { join } from 'node:path';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';

export interface SessionTask {
  specId: string;
  internalId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  agent?: string;
}

export interface SessionWave {
  number: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  tasks: SessionTask[];
}

export interface LaunchSession {
  specName: string;
  startedAt: string;
  totalWaves: number;
  currentWave: number;
  status: 'running' | 'completed' | 'failed';
  waves: SessionWave[];
}

const SESSION_FILE = 'session.json';

function sessionPath(dir: string): string {
  return join(dir, SESSION_FILE);
}

export async function writeSession(dir: string, session: LaunchSession): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(sessionPath(dir), JSON.stringify(session, null, 2));
}

export async function readSession(dir: string): Promise<LaunchSession | null> {
  try {
    const data = await readFile(sessionPath(dir), 'utf-8');
    return JSON.parse(data) as LaunchSession;
  } catch {
    return null;
  }
}

export async function clearSession(dir: string): Promise<void> {
  try {
    await rm(sessionPath(dir));
  } catch {
    // Ignore if file doesn't exist
  }
}
