import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PoolUsageStore } from '../../src/pool/usage-store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('PoolUsageStore', () => {
  let store: PoolUsageStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openhive-test-'));
    store = new PoolUsageStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should generate correct today key', () => {
    const key = store.todayKey();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const d = new Date();
    expect(key).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  });

  it('should generate Monday-based week key', () => {
    const key = store.weekKey();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The week key should be a Monday
    const parts = key.split('-').map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);
    expect(date.getDay()).toBe(1); // Monday
  });

  it('should record and retrieve daily dispatches', () => {
    store.recordDispatch('anthropic');
    store.recordDispatch('anthropic');
    store.recordDispatch('openai');

    const anthro = store.getDailyUsage('anthropic');
    expect(anthro.dispatched).toBe(2);
    expect(anthro.failed).toBe(0);

    const openai = store.getDailyUsage('openai');
    expect(openai.dispatched).toBe(1);
  });

  it('should record and retrieve weekly dispatches', () => {
    store.recordDispatch('anthropic');
    const weekly = store.getWeeklyUsage('anthropic');
    expect(weekly.dispatched).toBe(1);
  });

  it('should record failures', () => {
    store.recordDispatch('anthropic');
    store.recordFailure('anthropic');

    const daily = store.getDailyUsage('anthropic');
    expect(daily.dispatched).toBe(1);
    expect(daily.failed).toBe(1);

    const weekly = store.getWeeklyUsage('anthropic');
    expect(weekly.failed).toBe(1);
  });

  it('should return zero for unknown providers', () => {
    const usage = store.getDailyUsage('unknown');
    expect(usage.dispatched).toBe(0);
    expect(usage.failed).toBe(0);
  });

  it('should persist and reload data', async () => {
    store.recordDispatch('anthropic');
    store.recordDispatch('anthropic');
    await store.save();

    const store2 = new PoolUsageStore(tempDir);
    await store2.load();

    const daily = store2.getDailyUsage('anthropic');
    expect(daily.dispatched).toBe(2);
  });

  it('should handle load from non-existent file', async () => {
    await store.load();
    const daily = store.getDailyUsage('anthropic');
    expect(daily.dispatched).toBe(0);
  });

  it('should prune old buckets', () => {
    // Manually insert old data
    const data = store.getData();
    data.providers['anthropic'] = {
      daily: {
        '2020-01-01': { dispatched: 5, failed: 0 },
        [store.todayKey()]: { dispatched: 1, failed: 0 },
      },
      weekly: {
        '2020-01-01': { dispatched: 10, failed: 0 },
        [store.weekKey()]: { dispatched: 2, failed: 0 },
      },
    };

    store.prune();

    expect(data.providers['anthropic'].daily['2020-01-01']).toBeUndefined();
    expect(data.providers['anthropic'].daily[store.todayKey()]).toBeDefined();
    expect(data.providers['anthropic'].weekly['2020-01-01']).toBeUndefined();
    expect(data.providers['anthropic'].weekly[store.weekKey()]).toBeDefined();
  });
});
