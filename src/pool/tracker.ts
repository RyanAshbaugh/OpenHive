import type { ProviderPool } from './provider.js';
import type { ProviderPoolConfig } from '../config/schema.js';
import { PoolUsageStore } from './usage-store.js';
import { logger } from '../utils/logger.js';

export class PoolTracker {
  private pools = new Map<string, ProviderPool>();
  private configs = new Map<string, ProviderPoolConfig>();
  private usageStore: PoolUsageStore | null = null;

  constructor(poolConfigs: ProviderPoolConfig[], configDir?: string) {
    for (const config of poolConfigs) {
      this.configs.set(config.provider, config);
      this.pools.set(config.provider, {
        provider: config.provider,
        maxConcurrent: config.maxConcurrent,
        cooldownMs: config.cooldownMs,
        activeCount: 0,
        totalDispatched: 0,
        totalFailed: 0,
        rateLimited: false,
      });
    }
    if (configDir) {
      this.usageStore = new PoolUsageStore(configDir);
    }
  }

  async initUsageStore(): Promise<void> {
    if (this.usageStore) {
      await this.usageStore.load();
    }
  }

  getPool(provider: string): ProviderPool | undefined {
    return this.pools.get(provider);
  }

  getAllPools(): ProviderPool[] {
    return Array.from(this.pools.values());
  }

  canDispatch(provider: string): boolean {
    const pool = this.pools.get(provider);
    if (!pool) return false;

    if (pool.rateLimited) {
      if (pool.rateLimitedUntil && new Date(pool.rateLimitedUntil) > new Date()) {
        return false;
      }
      // Cooldown expired, reset
      pool.rateLimited = false;
      pool.rateLimitedUntil = undefined;
    }

    if (pool.activeCount >= pool.maxConcurrent) return false;

    // Check daily/weekly limits from usage store
    if (this.usageStore) {
      const config = this.configs.get(provider);
      if (config) {
        if (config.dailyLimit !== undefined) {
          const daily = this.usageStore.getDailyUsage(provider);
          if (daily.dispatched >= config.dailyLimit) return false;
        }
        if (config.weeklyLimit !== undefined) {
          const weekly = this.usageStore.getWeeklyUsage(provider);
          if (weekly.dispatched >= config.weeklyLimit) return false;
        }
      }
    }

    return true;
  }

  recordDispatch(provider: string): void {
    const pool = this.pools.get(provider);
    if (!pool) return;
    pool.activeCount++;
    pool.totalDispatched++;
    pool.lastDispatchAt = new Date().toISOString();
    logger.debug(`Pool ${provider}: dispatched (active=${pool.activeCount})`);

    if (this.usageStore) {
      this.usageStore.recordDispatch(provider);
      this.usageStore.save().catch(() => {});
    }
  }

  recordCompletion(provider: string): void {
    const pool = this.pools.get(provider);
    if (!pool) return;
    pool.activeCount = Math.max(0, pool.activeCount - 1);
    logger.debug(`Pool ${provider}: completed (active=${pool.activeCount})`);
  }

  recordFailure(provider: string, isRateLimit = false): void {
    const pool = this.pools.get(provider);
    if (!pool) return;
    pool.activeCount = Math.max(0, pool.activeCount - 1);
    pool.totalFailed++;
    pool.lastErrorAt = new Date().toISOString();

    if (isRateLimit) {
      pool.rateLimited = true;
      pool.rateLimitedUntil = new Date(Date.now() + pool.cooldownMs).toISOString();
      logger.warn(`Pool ${provider}: rate limited until ${pool.rateLimitedUntil}`);
    }

    if (this.usageStore) {
      this.usageStore.recordFailure(provider);
      this.usageStore.save().catch(() => {});
    }
  }

  /** Heuristic: detect rate limiting from agent output/exit code */
  isRateLimitSignal(exitCode: number, output: string): boolean {
    if (exitCode === 429) return true;
    const lower = output.toLowerCase();
    return lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('quota exceeded');
  }

  getDailyUsage(provider: string) {
    return this.usageStore?.getDailyUsage(provider) ?? { dispatched: 0, failed: 0 };
  }

  getWeeklyUsage(provider: string) {
    return this.usageStore?.getWeeklyUsage(provider) ?? { dispatched: 0, failed: 0 };
  }

  getDailyLimit(provider: string): number | undefined {
    return this.configs.get(provider)?.dailyLimit;
  }

  getWeeklyLimit(provider: string): number | undefined {
    return this.configs.get(provider)?.weeklyLimit;
  }

  async reloadUsageStore(): Promise<void> {
    if (this.usageStore) {
      await this.usageStore.reload();
    }
  }

  getUsageStore(): PoolUsageStore | null {
    return this.usageStore;
  }
}
