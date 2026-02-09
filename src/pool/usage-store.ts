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
      this.data.providers[provider] = { daily: {}, weekly: {} };
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

  /** Remove buckets older than 30 days */
  prune(): void {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    for (const provider of Object.values(this.data.providers)) {
      for (const key of Object.keys(provider.daily)) {
        if (key < cutoffStr) delete provider.daily[key];
      }
      for (const key of Object.keys(provider.weekly)) {
        if (key < cutoffStr) delete provider.weekly[key];
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
