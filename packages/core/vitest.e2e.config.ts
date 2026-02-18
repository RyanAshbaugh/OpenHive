import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 300_000,   // 5 min per test — real agents take time
    hookTimeout: 120_000,   // 2 min for setup/teardown
    include: ['test/e2e/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,   // Sequential: shared tmux session, shared agents
      },
    },
  },
});
