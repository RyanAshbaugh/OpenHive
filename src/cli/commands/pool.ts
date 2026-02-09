import type { Command } from 'commander';
import chalk from 'chalk';
import { getContext } from '../context.js';
import { printTable, printJson, isJsonOutput } from '../output.js';

function usageBar(value: number, limit: number | undefined, width = 12): string {
  if (limit === undefined) return String(value);
  const pct = Math.min(value / limit, 1);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const color = pct < 0.6 ? chalk.green : pct < 0.85 ? chalk.yellow : chalk.red;
  return color('█'.repeat(filled)) + chalk.gray('░'.repeat(empty)) + ` ${value}/${limit}`;
}

export function registerPoolCommand(program: Command): void {
  program
    .command('pool')
    .description('Show token pool status per provider')
    .action(async () => {
      const ctx = await getContext();
      const pools = ctx.poolTracker.getAllPools();

      if (isJsonOutput()) {
        const data = pools.map(p => ({
          ...p,
          daily: ctx.poolTracker.getDailyUsage(p.provider),
          weekly: ctx.poolTracker.getWeeklyUsage(p.provider),
          dailyLimit: ctx.poolTracker.getDailyLimit(p.provider),
          weeklyLimit: ctx.poolTracker.getWeeklyLimit(p.provider),
        }));
        printJson(data);
        return;
      }

      const rows = pools.map(p => {
        const daily = ctx.poolTracker.getDailyUsage(p.provider);
        const weekly = ctx.poolTracker.getWeeklyUsage(p.provider);
        const dailyLimit = ctx.poolTracker.getDailyLimit(p.provider);
        const weeklyLimit = ctx.poolTracker.getWeeklyLimit(p.provider);
        return [
          p.provider,
          `${p.activeCount}/${p.maxConcurrent}`,
          String(p.totalDispatched),
          String(p.totalFailed),
          p.rateLimited ? chalk.red('yes') : chalk.green('no'),
          usageBar(daily.dispatched, dailyLimit),
          usageBar(weekly.dispatched, weeklyLimit),
          p.lastDispatchAt?.slice(11, 19) ?? '-',
        ];
      });

      printTable(
        ['Provider', 'Active', 'Dispatched', 'Failed', 'Rate Limited', 'Daily', 'Weekly', 'Last Dispatch'],
        rows,
      );
    });
}
