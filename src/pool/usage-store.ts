import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

export interface DayBucket {
  dispatched: number;
  failed: number;
}

export interface ProviderUsage {
  daily: Record<string, DayBucket>;
  weekly: Record<string, DayBucket>;
  /** ISO timestamps of each dispatch, used for rolling window calculations */
  dispatches: string[];
}

export interface UsageStoreData {
  version: 1;
  providers: Record<string, ProviderUsage>;
}

export class PoolUsageStore {
  private data: UsageStoreData = { version: 1, providers: {} };
  private filePath: string;

  constructor(configDir: string) {
    this.filePath = join(configDir, 'pool-usage.json');
  }

  /** YYYY-MM-DD in local time */
  todayKey(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** YYYY-MM-DD in Pacific Time (for Google daily reset at midnight PT) */
  todayKeyPT(): string {
    const d = new Date();
    const pt = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    return `${pt.getFullYear()}-${String(pt.getMonth() + 1).padStart(2, '0')}-${String(pt.getDate()).padStart(2, '0')}`;
  }

  /** Monday-based ISO week start date as YYYY-MM-DD */
  weekKey(): string {
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1; // Monday = 0 offset
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
    return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
  }

  private ensureProvider(provider: string): ProviderUsage {
    if (!this.data.providers[provider]) {
      this.data.providers[provider] = { daily: {}, weekly: {}, dispatches: [] };
    }
    // Migrate old data that lacks dispatches array
    if (!this.data.providers[provider].dispatches) {
      this.data.providers[provider].dispatches = [];
    }
    return this.data.providers[provider];
  }

  private ensureBucket(record: Record<string, DayBucket>, key: string): DayBucket {
    if (!record[key]) {
      record[key] = { dispatched: 0, failed: 0 };
    }
    return record[key];
  }

  recordDispatch(provider: string): void {
    const usage = this.ensureProvider(provider);
    const dayBucket = this.ensureBucket(usage.daily, this.todayKey());
    const weekBucket = this.ensureBucket(usage.weekly, this.weekKey());
    dayBucket.dispatched++;
    weekBucket.dispatched++;
    usage.dispatches.push(new Date().toISOString());
  }

  recordFailure(provider: string): void {
    const usage = this.ensureProvider(provider);
    const dayBucket = this.ensureBucket(usage.daily, this.todayKey());
    const weekBucket = this.ensureBucket(usage.weekly, this.weekKey());
    dayBucket.failed++;
    weekBucket.failed++;
  }

  getDailyUsage(provider: string): DayBucket {
    const usage = this.data.providers[provider];
    if (!usage) return { dispatched: 0, failed: 0 };
    return usage.daily[this.todayKey()] ?? { dispatched: 0, failed: 0 };
  }

  getWeeklyUsage(provider: string): DayBucket {
    const usage = this.data.providers[provider];
    if (!usage) return { dispatched: 0, failed: 0 };
    return usage.weekly[this.weekKey()] ?? { dispatched: 0, failed: 0 };
  }

  /** Count dispatches within a rolling window (e.g. last 5 hours) */
  getRollingCount(provider: string, windowMs: number): number {
    const usage = this.data.providers[provider];
    if (!usage?.dispatches) return 0;
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    return usage.dispatches.filter(ts => ts >= cutoff).length;
  }

  /** Count dispatches today in Pacific Time (for Google's midnight PT reset) */
  getDailyCountPT(provider: string): number {
    const usage = this.data.providers[provider];
    if (!usage?.dispatches) return 0;
    // Get start of today in PT
    const now = new Date();
    const ptStr = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    const ptNow = new Date(ptStr);
    const startOfDayPT = new Date(ptNow.getFullYear(), ptNow.getMonth(), ptNow.getDate());
    // Convert back to UTC for comparison
    const offset = now.getTime() - ptNow.getTime();
    const cutoff = new Date(startOfDayPT.getTime() + offset).toISOString();
    return usage.dispatches.filter(ts => ts >= cutoff).length;
  }

  /** Count dispatches in the last N milliseconds (for RPM-style windows) */
  getWindowCount(provider: string, windowMs: number): number {
    return this.getRollingCount(provider, windowMs);
  }

  /** Get the timestamp of the oldest dispatch in a rolling window (for reset countdown) */
  getOldestInWindow(provider: string, windowMs: number): string | undefined {
    const usage = this.data.providers[provider];
    if (!usage?.dispatches) return undefined;
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const inWindow = usage.dispatches.filter(ts => ts >= cutoff).sort();
    return inWindow[0];
  }

  /** Remove buckets older than 30 days and dispatch timestamps older than 8 days */
  prune(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const dispatchCutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

    for (const provider of Object.values(this.data.providers)) {
      for (const key of Object.keys(provider.daily)) {
        if (key < cutoffStr) delete provider.daily[key];
      }
      for (const key of Object.keys(provider.weekly)) {
        if (key < cutoffStr) delete provider.weekly[key];
      }
      if (provider.dispatches) {
        provider.dispatches = provider.dispatches.filter(ts => ts >= dispatchCutoff);
      }
    }
  }

  async load(): Promise<void> {
    try {
      const content = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(content) as UsageStoreData;
      if (parsed.version === 1 && parsed.providers) {
        this.data = parsed;
      }
    } catch {
      // File doesn't exist or is invalid — start fresh
      this.data = { version: 1, providers: {} };
    }
  }

  async save(): Promise<void> {
    this.prune();
    try {
      const dir = this.filePath.replace(/[/\\][^/\\]+$/, '');
      await mkdir(dir, { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      logger.warn(`Failed to save pool usage: ${err}`);
    }
  }

  async reload(): Promise<void> {
    await this.load();
  }

  getData(): UsageStoreData {
    return this.data;
  }
}
