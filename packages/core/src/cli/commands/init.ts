import type { Command } from 'commander';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getContext } from '../context.js';
import { printSuccess, printInfo, printTable, printJson, isJsonOutput } from '../output.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize OpenHive in the current repository')
    .action(async () => {
      const ctx = await getContext();

      // Detect available agents
      const statuses = await ctx.registry.checkAll(ctx.config);

      if (!isJsonOutput()) {
        printInfo('Detecting available agents...');
      }

      const available = statuses.filter(s => s.available);
      const rows = statuses.map(s => [
        s.adapter.displayName,
        s.adapter.command,
        s.available ? 'found' : 'not found',
        s.enabled ? 'yes' : 'no',
      ]);

      if (isJsonOutput()) {
        printJson({
          agents: statuses.map(s => ({
            name: s.adapter.name,
            displayName: s.adapter.displayName,
            available: s.available,
            enabled: s.enabled,
          })),
        });
      } else {
        printTable(['Agent', 'Command', 'Status', 'Enabled'], rows);
      }

      // Create local config directory
      const configDir = join(process.cwd(), '.openhive');
      await mkdir(configDir, { recursive: true });

      // Write initial config
      const localConfig = {
        agents: Object.fromEntries(
          statuses.map(s => [s.adapter.name, { enabled: s.available }])
        ),
      };
      await writeFile(
        join(configDir, 'config.json'),
        JSON.stringify(localConfig, null, 2),
        'utf-8',
      );

      printSuccess(`Initialized OpenHive with ${available.length} available agent(s)`);
    });
}
