import type { Command } from 'commander';
import chalk from 'chalk';
import { getContext } from '../context.js';
import { printTable, printJson, isJsonOutput } from '../output.js';

export function registerAgentsCommand(program: Command): void {
  program
    .command('agents')
    .description('List registered agents and their availability')
    .action(async () => {
      const ctx = await getContext();
      const statuses = await ctx.registry.checkAll(ctx.config);

      if (isJsonOutput()) {
        printJson(statuses.map(s => ({
          name: s.adapter.name,
          displayName: s.adapter.displayName,
          provider: s.adapter.provider,
          command: s.adapter.command,
          available: s.available,
          enabled: s.enabled,
          modes: s.adapter.supportedModes,
          capabilities: s.adapter.capabilities,
        })));
        return;
      }

      const rows = statuses.map(s => [
        s.adapter.displayName,
        s.adapter.name,
        s.adapter.provider,
        s.available ? chalk.green('available') : chalk.gray('not found'),
        s.enabled ? chalk.green('yes') : chalk.gray('no'),
        s.adapter.supportedModes.join(', '),
      ]);

      printTable(['Agent', 'Name', 'Provider', 'Status', 'Enabled', 'Modes'], rows);
    });
}
