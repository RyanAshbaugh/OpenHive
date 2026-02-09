import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { writeSession, readSession, clearSession, type LaunchSession } from '../../src/specs/session.js';

describe('session', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openhive-session-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const makeSession = (overrides?: Partial<LaunchSession>): LaunchSession => ({
    specName: 'Test Project',
    startedAt: '2025-01-01T00:00:00.000Z',
    totalWaves: 2,
    currentWave: 1,
    status: 'running',
    waves: [
      {
        number: 1,
        status: 'running',
        tasks: [
          { specId: 'scaffold', internalId: 'abc123', status: 'running' },
        ],
      },
      {
        number: 2,
        status: 'pending',
        tasks: [
          { specId: 'api', internalId: '', status: 'pending' },
        ],
      },
    ],
    ...overrides,
  });

  describe('writeSession + readSession', () => {
    it('should write and read a session', async () => {
      const session = makeSession();
      await writeSession(dir, session);
      const loaded = await readSession(dir);
      expect(loaded).toEqual(session);
    });

    it('should overwrite existing session', async () => {
      await writeSession(dir, makeSession({ currentWave: 1 }));
      await writeSession(dir, makeSession({ currentWave: 2 }));
      const loaded = await readSession(dir);
      expect(loaded?.currentWave).toBe(2);
    });

    it('should create directory if it does not exist', async () => {
      const nested = join(dir, 'nested', 'deep');
      await writeSession(nested, makeSession());
      const loaded = await readSession(nested);
      expect(loaded?.specName).toBe('Test Project');
    });
  });

  describe('readSession', () => {
    it('should return null if no session file exists', async () => {
      const loaded = await readSession(dir);
      expect(loaded).toBeNull();
    });

    it('should return null for non-existent directory', async () => {
      const loaded = await readSession(join(dir, 'nope'));
      expect(loaded).toBeNull();
    });
  });

  describe('clearSession', () => {
    it('should remove session file', async () => {
      await writeSession(dir, makeSession());
      await clearSession(dir);
      const loaded = await readSession(dir);
      expect(loaded).toBeNull();
    });

    it('should not throw if session file does not exist', async () => {
      await expect(clearSession(dir)).resolves.not.toThrow();
    });
  });

  describe('session lifecycle', () => {
    it('should track a full launch lifecycle', async () => {
      // Start
      const session = makeSession();
      await writeSession(dir, session);

      // Wave 1 completes
      session.waves[0].status = 'completed';
      session.waves[0].tasks[0].status = 'completed';
      session.currentWave = 2;
      session.waves[1].status = 'running';
      session.waves[1].tasks[0].internalId = 'def456';
      session.waves[1].tasks[0].status = 'running';
      await writeSession(dir, session);

      let loaded = await readSession(dir);
      expect(loaded?.currentWave).toBe(2);
      expect(loaded?.waves[0].status).toBe('completed');
      expect(loaded?.waves[1].status).toBe('running');

      // Wave 2 completes, launch done
      session.waves[1].status = 'completed';
      session.waves[1].tasks[0].status = 'completed';
      session.status = 'completed';
      await writeSession(dir, session);

      loaded = await readSession(dir);
      expect(loaded?.status).toBe('completed');
      expect(loaded?.waves.every(w => w.status === 'completed')).toBe(true);
    });
  });
});
