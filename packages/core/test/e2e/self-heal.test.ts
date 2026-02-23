/**
 * Self-Heal Capability Tests — verify agents can actually fix broken code.
 *
 * Each scenario:
 *   1. Creates a temp dir with npm init, vitest, git init
 *   2. Seeds broken source code + a correct vitest test
 *   3. Calls runWithSelfHealing() with real claude agent
 *   4. Asserts result.success === true
 *   5. Cleans up
 *
 * Requires: `claude --version` available. Skips otherwise.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { runWithSelfHealing } from '../../src/cli/commands/self-heal.js';
import { checkAgentAvailability } from './helpers/agent-check.js';

const execFileAsync = promisify(execFile);

// ─── Availability check ──────────────────────────────────────────────────────

const avail = await checkAgentAvailability();

if (!avail.claude || !avail.tmux) {
  console.log(`Skipping self-heal tests: ${!avail.claude ? 'claude' : 'tmux'} not available`);
}

// ─── Helper: scaffold a scenario directory ───────────────────────────────────

interface ScenarioDir {
  root: string;
  cleanup: () => Promise<void>;
}

const activeDirs: ScenarioDir[] = [];

async function createScenarioDir(prefix: string): Promise<ScenarioDir> {
  const root = await mkdtemp(join(tmpdir(), `openhive-selfheal-${prefix}-`));

  // npm init + install vitest
  await execFileAsync('npm', ['init', '-y'], { cwd: root, timeout: 15_000 });

  // Set "type": "module" in package.json
  const pkgPath = join(root, 'package.json');
  const pkg = JSON.parse(
    (await execFileAsync('cat', [pkgPath])).stdout,
  );
  pkg.type = 'module';
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

  await execFileAsync('npm', ['install', '-D', 'vitest'], {
    cwd: root,
    timeout: 60_000,
  });

  // Write vitest config
  await writeFile(
    join(root, 'vitest.config.js'),
    `import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { globals: true },
});
`,
  );

  // Git init + initial commit
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 'test@openhive.dev'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 'OpenHive Test'], { cwd: root });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  await execFileAsync('git', ['add', '-A'], { cwd: root });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: root });

  const dir: ScenarioDir = {
    root,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
  activeDirs.push(dir);
  return dir;
}

// Clean up any dirs that tests created
afterEach(async () => {
  while (activeDirs.length > 0) {
    const dir = activeDirs.pop()!;
    await dir.cleanup();
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe.skipIf(!avail.claude || !avail.tmux)('Self-heal capability', () => {
  it('Scenario 1: fixes a typo in a greeting', async () => {
    const { root } = await createScenarioDir('typo');

    // Broken source: "Hello Wrold" instead of "Hello World"
    await writeFile(
      join(root, 'greeting.js'),
      `export function greet(name) {
  return \`Hello Wrold, \${name}!\`;
}
`,
    );

    // Correct test
    await writeFile(
      join(root, 'greeting.test.js'),
      `import { greet } from './greeting.js';
import { expect, it } from 'vitest';

it('greets correctly', () => {
  expect(greet('Alice')).toBe('Hello World, Alice!');
});
`,
    );

    // Commit the broken state so the agent can modify files
    await execFileAsync('git', ['add', '-A'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'add broken greeting'], { cwd: root });

    const result = await runWithSelfHealing({
      command: 'npx',
      args: ['vitest', 'run'],
      cwd: root,
      agent: 'claude',
      maxRetries: 3,
      testTimeout: 30_000,
    });

    expect(result.success).toBe(true);
  });

  it('Scenario 2: adds a missing export', async () => {
    const { root } = await createScenarioDir('export');

    // Source only exports subtract — add is missing
    await writeFile(
      join(root, 'math.js'),
      `export function subtract(a, b) {
  return a - b;
}
`,
    );

    // Test imports both add and subtract
    await writeFile(
      join(root, 'math.test.js'),
      `import { add, subtract } from './math.js';
import { expect, it } from 'vitest';

it('adds two numbers', () => {
  expect(add(2, 3)).toBe(5);
});

it('subtracts two numbers', () => {
  expect(subtract(5, 3)).toBe(2);
});
`,
    );

    await execFileAsync('git', ['add', '-A'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'add broken math'], { cwd: root });

    const result = await runWithSelfHealing({
      command: 'npx',
      args: ['vitest', 'run'],
      cwd: root,
      agent: 'claude',
      maxRetries: 3,
      testTimeout: 30_000,
    });

    expect(result.success).toBe(true);
  });

  it('Scenario 3: fixes a route param bug', async () => {
    const { root } = await createScenarioDir('route');

    // Install express for this scenario
    await execFileAsync('npm', ['install', 'express'], {
      cwd: root,
      timeout: 60_000,
    });

    // Source uses req.params.itemId (wrong) instead of req.params.id
    await writeFile(
      join(root, 'app.js'),
      `import express from 'express';

const app = express();

const items = [
  { id: '1', name: 'Widget' },
  { id: '2', name: 'Gadget' },
];

app.get('/items/:id', (req, res) => {
  const item = items.find(i => i.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

export default app;
`,
    );

    // Test that hits the route correctly
    await writeFile(
      join(root, 'app.test.js'),
      `import { expect, it, afterAll } from 'vitest';
import app from './app.js';

let server;
let baseUrl;

// Start server on a random port
const start = () => new Promise((resolve) => {
  server = app.listen(0, () => {
    const port = server.address().port;
    baseUrl = \`http://localhost:\${port}\`;
    resolve();
  });
});

const stop = () => new Promise((resolve) => {
  if (server) server.close(resolve);
  else resolve();
});

afterAll(async () => { await stop(); });

it('GET /items/:id returns the item', async () => {
  await start();
  const res = await fetch(\`\${baseUrl}/items/1\`);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toEqual({ id: '1', name: 'Widget' });
});
`,
    );

    await execFileAsync('git', ['add', '-A'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'add broken route'], { cwd: root });

    const result = await runWithSelfHealing({
      command: 'npx',
      args: ['vitest', 'run'],
      cwd: root,
      agent: 'claude',
      maxRetries: 3,
      testTimeout: 30_000,
    });

    expect(result.success).toBe(true);
  });
});
