import type { Command } from 'commander';
import { getContext } from '../context.js';
import { runDashboard } from '../dashboard.js';

export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .alias('dash')
    .description('Full-screen live terminal dashboard')
    .action(async () => {
      const ctx = await getContext();
      await runDashboard(ctx);
    });
}
