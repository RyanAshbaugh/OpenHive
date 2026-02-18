/**
 * Read actual usage data from each CLI tool's local data files.
 *
 * These readers inspect the data directories that each tool writes to,
 * providing a view of total platform usage — not just OpenHive dispatches.
 *
 * Data sources:
 *   Claude:  ~/.claude/stats-cache.json — daily message counts, tokens by model, sessions
 *   Codex:   ~/.codex/sessions/YYYY/MM/DD/*.jsonl — session files (count only)
 *   Gemini:  No local usage stats available
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Common types ───────────────────────────────────────────────────────────

export interface ToolDayUsage {
  date: string;
  messages: number;
  sessions: number;
  toolCalls: number;
  tokens: number;
}

export interface ToolUsageReport {
  provider: string;
  available: boolean;
  today: ToolDayUsage | null;
  recent: ToolDayUsage[];  // last 7 days
  totalSessions?: number;
  error?: string;
}

// ─── Claude ─────────────────────────────────────────────────────────────────

interface ClaudeStatsCache {
  dailyActivity?: { date: string; messageCount: number; sessionCount: number; toolCallCount: number }[];
  dailyModelTokens?: { date: string; tokensByModel: Record<string, number> }[];
  totalSessions?: number;
}

async function readClaudeUsage(): Promise<ToolUsageReport> {
  const statsPath = join(homedir(), '.claude', 'stats-cache.json');
  try {
    const raw = await readFile(statsPath, 'utf-8');
    const stats: ClaudeStatsCache = JSON.parse(raw);

    const todayStr = new Date().toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const tokensByDate = new Map<string, number>();
    if (stats.dailyModelTokens) {
      for (const entry of stats.dailyModelTokens) {
        const total = Object.values(entry.tokensByModel).reduce((a, b) => a + b, 0);
        tokensByDate.set(entry.date, total);
      }
    }

    const days: ToolDayUsage[] = [];
    if (stats.dailyActivity) {
      for (const day of stats.dailyActivity) {
        if (day.date >= sevenDaysAgo) {
          days.push({
            date: day.date,
            messages: day.messageCount,
            sessions: day.sessionCount,
            toolCalls: day.toolCallCount,
            tokens: tokensByDate.get(day.date) ?? 0,
          });
        }
      }
    }

    const today = days.find(d => d.date === todayStr) ?? null;

    return {
      provider: 'anthropic',
      available: true,
      today,
      recent: days,
      totalSessions: stats.totalSessions,
    };
  } catch (err) {
    return { provider: 'anthropic', available: false, today: null, recent: [], error: String(err) };
  }
}

// ─── Codex ──────────────────────────────────────────────────────────────────

async function readCodexUsage(): Promise<ToolUsageReport> {
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    const [year, month, day] = todayStr.split('-');
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const days: ToolDayUsage[] = [];

    // Walk recent date directories
    for (let i = 0; i < 7; i++) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const y = String(d.getFullYear());
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const dayDir = join(sessionsDir, y, m, dd);

      try {
        const files = await readdir(dayDir);
        const sessionFiles = files.filter(f => f.endsWith('.jsonl'));
        if (sessionFiles.length > 0) {
          days.push({
            date: `${y}-${m}-${dd}`,
            messages: 0,  // Would need to parse JSONL for message counts
            sessions: sessionFiles.length,
            toolCalls: 0,
            tokens: 0,
          });
        }
      } catch {
        // Day directory doesn't exist
      }
    }

    const today = days.find(d => d.date === todayStr) ?? null;

    return {
      provider: 'openai',
      available: days.length > 0,
      today,
      recent: days.reverse(),
    };
  } catch (err) {
    return { provider: 'openai', available: false, today: null, recent: [], error: String(err) };
  }
}

// ─── Gemini ─────────────────────────────────────────────────────────────────

async function readGeminiUsage(): Promise<ToolUsageReport> {
  // Gemini CLI doesn't store local usage stats
  return {
    provider: 'google',
    available: false,
    today: null,
    recent: [],
    error: 'Gemini CLI does not expose local usage statistics',
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

const readers: Record<string, () => Promise<ToolUsageReport>> = {
  anthropic: readClaudeUsage,
  openai: readCodexUsage,
  google: readGeminiUsage,
};

export async function readToolUsage(provider: string): Promise<ToolUsageReport> {
  const reader = readers[provider];
  if (!reader) {
    return { provider, available: false, today: null, recent: [], error: 'No usage reader for provider' };
  }
  return reader();
}

export async function readAllToolUsage(): Promise<Map<string, ToolUsageReport>> {
  const results = new Map<string, ToolUsageReport>();
  const providers = Object.keys(readers);
  const reports = await Promise.all(providers.map(p => readToolUsage(p)));
  for (const report of reports) {
    results.set(report.provider, report);
  }
  return results;
}
