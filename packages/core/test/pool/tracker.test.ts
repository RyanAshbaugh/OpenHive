import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PoolTracker } from '../../src/pool/tracker.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('PoolTracker', () => {
  let tracker: PoolTracker;

  beforeEach(() => {
    tracker = new PoolTracker([
      { provider: 'anthropic', maxConcurrent: 2, cooldownMs: 5000 },
      { provider: 'openai', maxConcurrent: 1, cooldownMs: 10000 },
    ]);
  });

  it('should initialize pools from config', () => {
    const pools = tracker.getAllPools();
    expect(pools.length).toBe(2);
    expect(pools[0].provider).toBe('anthropic');
    expect(pools[1].provider).toBe('openai');
  });

  it('should allow dispatch when under capacity', () => {
    expect(tracker.canDispatch('anthropic')).toBe(true);
    expect(tracker.canDispatch('openai')).toBe(true);
  });

  it('should block dispatch at capacity', () => {
    tracker.recordDispatch('openai');
    expect(tracker.canDispatch('openai')).toBe(false);
  });

  it('should allow dispatch after completion', () => {
    tracker.recordDispatch('openai');
    expect(tracker.canDispatch('openai')).toBe(false);

    tracker.recordCompletion('openai');
    expect(tracker.canDispatch('openai')).toBe(true);
  });

  it('should track dispatch counts', () => {
    tracker.recordDispatch('anthropic');
    tracker.recordDispatch('anthropic');
    tracker.recordCompletion('anthropic');
    tracker.recordDispatch('anthropic');

    const pool = tracker.getPool('anthropic')!;
    expect(pool.totalDispatched).toBe(3);
    expect(pool.activeCount).toBe(2);
  });

  it('should track failures', () => {
    tracker.recordDispatch('anthropic');
    tracker.recordFailure('anthropic', false);

    const pool = tracker.getPool('anthropic')!;
    expect(pool.totalFailed).toBe(1);
    expect(pool.activeCount).toBe(0);
    expect(pool.rateLimited).toBe(false);
  });

  it('should handle rate limiting', () => {
    tracker.recordDispatch('anthropic');
    tracker.recordFailure('anthropic', true);

    const pool = tracker.getPool('anthropic')!;
    expect(pool.rateLimited).toBe(true);
    expect(pool.rateLimitedUntil).toBeDefined();
    expect(tracker.canDispatch('anthropic')).toBe(false);
  });

  it('should detect rate limit signals from output', () => {
    expect(tracker.isRateLimitSignal(429, '')).toBe(true);
    expect(tracker.isRateLimitSignal(1, 'Error: rate limit exceeded')).toBe(true);
    expect(tracker.isRateLimitSignal(1, 'Error: too many requests')).toBe(true);
    expect(tracker.isRateLimitSignal(1, 'quota exceeded for model')).toBe(true);
    expect(tracker.isRateLimitSignal(0, 'done')).toBe(false);
    expect(tracker.isRateLimitSignal(1, 'syntax error')).toBe(false);
  });

  it('should return false for unknown provider', () => {
    expect(tracker.canDispatch('unknown')).toBe(false);
    expect(tracker.getPool('unknown')).toBeUndefined();
  });

  it('should not go below zero active count', () => {
    tracker.recordCompletion('anthropic');
    const pool = tracker.getPool('anthropic')!;
    expect(pool.activeCount).toBe(0);
  });

  it('should expose daily/weekly usage accessors without store', () => {
    const daily = tracker.getDailyUsage('anthropic');
    expect(daily.dispatched).toBe(0);
    expect(daily.failed).toBe(0);

    const weekly = tracker.getWeeklyUsage('anthropic');
    expect(weekly.dispatched).toBe(0);
  });

  it('should return undefined limits when not configured', () => {
    expect(tracker.getDailyLimit('anthropic')).toBeUndefined();
    expect(tracker.getWeeklyLimit('anthropic')).toBeUndefined();
  });
});

describe('PoolTracker with usage store', () => {
  let tracker: PoolTracker;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'openhive-tracker-'));
    tracker = new PoolTracker(
      [
        { provider: 'anthropic', maxConcurrent: 5, cooldownMs: 1000, dailyLimit: 3, weeklyLimit: 10 },
        { provider: 'openai', maxConcurrent: 5, cooldownMs: 1000 },
      ],
      tempDir,
    );
    await tracker.initUsageStore();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should track dispatches in usage store', () => {
    tracker.recordDispatch('anthropic');
    tracker.recordDispatch('anthropic');

    const daily = tracker.getDailyUsage('anthropic');
    expect(daily.dispatched).toBe(2);
  });

  it('should block dispatch when daily limit reached', () => {
    tracker.recordDispatch('anthropic');
    tracker.recordCompletion('anthropic');
    tracker.recordDispatch('anthropic');
    tracker.recordCompletion('anthropic');
    tracker.recordDispatch('anthropic');
    tracker.recordCompletion('anthropic');

    // Daily limit is 3, we dispatched 3
    expect(tracker.canDispatch('anthropic')).toBe(false);
  });

  it('should allow dispatch when under daily limit', () => {
    tracker.recordDispatch('anthropic');
    tracker.recordCompletion('anthropic');
    tracker.recordDispatch('anthropic');
    tracker.recordCompletion('anthropic');

    // Daily limit is 3, we dispatched 2
    expect(tracker.canDispatch('anthropic')).toBe(true);
  });

  it('should track failures in usage store', () => {
    tracker.recordDispatch('anthropic');
    tracker.recordFailure('anthropic');

    const daily = tracker.getDailyUsage('anthropic');
    expect(daily.failed).toBe(1);
  });

  it('should return configured limits', () => {
    expect(tracker.getDailyLimit('anthropic')).toBe(3);
    expect(tracker.getWeeklyLimit('anthropic')).toBe(10);
    expect(tracker.getDailyLimit('openai')).toBeUndefined();
  });

  it('should allow dispatch when provider has no daily limit', () => {
    tracker.recordDispatch('openai');
    tracker.recordCompletion('openai');
    expect(tracker.canDispatch('openai')).toBe(true);
  });
});
