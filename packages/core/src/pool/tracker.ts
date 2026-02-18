import type { ProviderPool } from './provider.js';
import type { ProviderPoolConfig } from '../config/schema.js';
import { PoolUsageStore } from './usage-store.js';
import { getProviderLimits } from './limits.js';
import type { RateLimitWindow } from './limits.js';
import { logger } from '../utils/logger.js';

/** Summary of a single rate limit window for dashboard display */
export interface WindowSummary {
  id: string;
  label: string;
  type: 'rolling' | 'fixed';
  used: number;
  limit: number | undefined;
  /** For rolling windows: ms until the oldest dispatch in the window expires */
  resetInMs?: number;
  /** Human-readable reset description */
  resetDescription: string;
}

/** Full usage summary for a provider */
export interface ProviderUsageSummary {
  provider: string;
  activeCount: number;
  maxConcurrent: number;
  windows: WindowSummary[];
}

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

    // Check provider-specific limits
    if (this.usageStore) {
      const config = this.configs.get(provider);
      const limits = getProviderLimits(provider);

      if (limits && config) {
        for (const win of limits.windows) {
          const configuredLimit = this.getWindowLimit(provider, win);
          if (configuredLimit === undefined) continue;

          const used = this.getWindowUsed(provider, win);
          if (used >= configuredLimit) return false;
        }
      }

      // Legacy support for dailyLimit/weeklyLimit
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

  // ─── Provider-specific window queries ──────────────────────────────────────

  /** Get the configured or default limit for a specific window */
  private getWindowLimit(provider: string, win: RateLimitWindow): number | undefined {
    const config = this.configs.get(provider);
    if (config?.windows) {
      const override = config.windows.find(w => w.id === win.id);
      if (override?.limit !== undefined) return override.limit;
    }
    return win.defaultLimit;
  }

  /** Get the current usage count for a specific window */
  private getWindowUsed(provider: string, win: RateLimitWindow): number {
    if (!this.usageStore) return 0;

    if (win.type === 'rolling') {
      return this.usageStore.getRollingCount(provider, win.windowMs);
    }

    // Fixed windows
    if (win.id === 'daily') {
      return this.usageStore.getDailyCountPT(provider);
    }
    if (win.id === 'rpm') {
      return this.usageStore.getWindowCount(provider, win.windowMs);
    }

    // Fallback: use rolling count for unknown fixed windows
    return this.usageStore.getRollingCount(provider, win.windowMs);
  }

  /** Get reset countdown for a rolling window */
  private getResetInMs(provider: string, win: RateLimitWindow): number | undefined {
    if (!this.usageStore) return undefined;

    if (win.type === 'rolling') {
      const oldest = this.usageStore.getOldestInWindow(provider, win.windowMs);
      if (!oldest) return undefined;
      const expiresAt = new Date(oldest).getTime() + win.windowMs;
      return Math.max(0, expiresAt - Date.now());
    }

    // Fixed daily (midnight PT)
    if (win.id === 'daily') {
      const now = new Date();
      const ptStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
      const ptNow = new Date(ptStr);
      const midnight = new Date(ptNow.getFullYear(), ptNow.getMonth(), ptNow.getDate() + 1);
      const offset = now.getTime() - ptNow.getTime();
      return midnight.getTime() + offset - Date.now();
    }

    // RPM resets every minute — not worth showing countdown
    return undefined;
  }

  /** Get a full usage summary for a provider, ready for dashboard display */
  getUsageSummary(provider: string): ProviderUsageSummary {
    const pool = this.pools.get(provider);
    const limits = getProviderLimits(provider);

    const windows: WindowSummary[] = [];

    if (limits) {
      for (const win of limits.windows) {
        windows.push({
          id: win.id,
          label: win.label,
          type: win.type,
          used: this.getWindowUsed(provider, win),
          limit: this.getWindowLimit(provider, win),
          resetInMs: this.getResetInMs(provider, win),
          resetDescription: win.resetDescription,
        });
      }
    }

    return {
      provider,
      activeCount: pool?.activeCount ?? 0,
      maxConcurrent: pool?.maxConcurrent ?? 0,
      windows,
    };
  }

  // ─── Legacy accessors (kept for backward compat with tests) ────────────────

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
