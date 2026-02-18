export interface ProviderPool {
  provider: string;
  maxConcurrent: number;
  cooldownMs: number;
  activeCount: number;
  totalDispatched: number;
  totalFailed: number;
  lastDispatchAt?: string;
  lastErrorAt?: string;
  rateLimited: boolean;
  rateLimitedUntil?: string;
}
