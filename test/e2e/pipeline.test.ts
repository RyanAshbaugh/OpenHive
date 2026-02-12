/**
 * E2E Pipeline Tests — Multi-agent orchestration with real agents.
 *
 * These tests exercise the REAL orchestrator path:
 *   Orchestrator → WorkerSession (tmux windows) → real agents in interactive mode
 *   → state detection → auto-approve → task completion detection
 *
 * Three tiers of increasing complexity:
 *   Tier 1: Simple file creation (~30-60s)
 *   Tier 2: Web page with HTML/CSS/JS (~60-120s)
 *   Tier 3: REST API + tests (~2-5min)
 *
 * All tiers skip automatically if agents are not installed.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { createTask } from '../../src/tasks/task.js';
import type { OrchestratorEvent } from '../../src/orchestrator/types.js';

import { checkAgentAvailability, allAgentsAvailable, unavailableSummary } from './helpers/agent-check.js';
import type { AgentAvailability } from './helpers/agent-check.js';
import { createTestRepo, git, forceCommitWorktree } from './helpers/test-repo.js';
import type { TestRepo } from './helpers/test-repo.js';
import { mergeAllBranches, verifyFiles } from './helpers/merge-verify.js';
import type { FileExpectation } from './helpers/merge-verify.js';

const execFileAsync = promisify(execFile);

// ─── Shared setup ────────────────────────────────────────────────────────────
// Top-level await: describe.skipIf() is evaluated at collection time (before
// beforeAll), so we must resolve availability synchronously at module level.

const avail = await checkAgentAvailability();

if (!allAgentsAvailable(avail)) {
  console.log(`Skipping e2e tests: ${unavailableSummary(avail)}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run the full orchestrator pipeline for a set of tasks:
 * 1. Create test repo
 * 2. Queue tasks with the orchestrator (useWorktrees: true)
 * 3. Start orchestrator → agents run in worktrees
 * 4. Force-commit worktree changes
 * 5. Merge all branches to main
 * 6. Verify results
 * 7. Shutdown + cleanup
 */
async function runPipeline(
  tasks: Array<{ id: string; agent: string; prompt: string }>,
  expectations: FileExpectation[],
  options?: {
    setupRepo?: (repo: TestRepo) => Promise<void>;
    postMerge?: (repoRoot: string) => Promise<void>;
  },
): Promise<void> {
  const repo = await createTestRepo();
  const events: OrchestratorEvent[] = [];

  try {
    // Optional repo setup (e.g., npm init for Tier 3)
    if (options?.setupRepo) {
      await options.setupRepo(repo);
    }

    // Create orchestrator with worktree support
    const orchestrator = new Orchestrator({
      config: {
        maxWorkers: 3,
        autoApprove: true,
        tickIntervalMs: 2000,
        useWorktrees: true,
        worktreeDir: '.openhive-worktrees',
        repoRoot: repo.root,
        idleSettlingMs: 3000,
        stuckTimeoutMs: 180_000, // 3 min stuck timeout for real agents
      },
      onEvent: (e) => {
        events.push(e);
        if (e.type === 'task_completed' || e.type === 'task_failed') {
          console.log(`  [e2e] ${e.type}: ${e.taskId}`);
        }
      },
    });

    // Queue all tasks
    for (const t of tasks) {
      const task = createTask(t.prompt, t.id, { agent: t.agent });
      orchestrator.queueTask(task);
    }

    // Start orchestrator — blocks until all tasks complete
    console.log(`  [e2e] Starting orchestrator with ${tasks.length} tasks...`);
    await orchestrator.start();

    // Verify all tasks completed (not failed)
    for (const t of tasks) {
      if (orchestrator.isTaskFailed(t.id)) {
        const reason = orchestrator.getFailureReason(t.id);
        throw new Error(`Task ${t.id} (${t.agent}) failed: ${reason}`);
      }
      expect(orchestrator.isTaskCompleted(t.id)).toBe(true);
    }

    // Force-commit any unstaged changes in each worktree and collect branches
    const branches: string[] = [];
    const workerStates = orchestrator.getWorkerStates();

    // We need the task objects to get worktree paths — retrieve from events
    for (const t of tasks) {
      // Find the worktree path from the task (it was set during dispatch)
      const worktreePath = join(repo.root, '.openhive-worktrees', t.id);
      try {
        // List files in the worktree for diagnostics
        const files = await readdir(worktreePath).catch(() => []);
        console.log(`  [e2e] Worktree ${t.id} files: ${files.filter(f => !f.startsWith('.')).join(', ') || '(none)'}`);

        const branch = await forceCommitWorktree(
          worktreePath,
          `[openhive] ${t.agent} completed task ${t.id}`,
        );
        branches.push(branch);
        console.log(`  [e2e] Committed worktree: ${branch}`);
      } catch (err) {
        console.warn(`  [e2e] Warning: could not commit worktree for ${t.id}: ${err}`);
      }
    }

    // Shutdown orchestrator (stops workers, kills tmux session)
    if (!process.env.OPENHIVE_KEEP_ARTIFACTS) {
      await orchestrator.shutdown();
    }

    // Ensure we're on main branch
    await git(repo.root, 'checkout', 'main');

    // Merge all branches
    console.log(`  [e2e] Merging ${branches.length} branches to main...`);
    const mergeResult = await mergeAllBranches(repo.root, branches);

    if (!mergeResult.success) {
      const failedBranches = mergeResult.failed.map(f => `${f.branch}: ${f.error}`).join('; ');
      throw new Error(`Merge failed for: ${failedBranches}`);
    }

    // List files after merge for diagnostics
    const mergedFiles = await readdir(repo.root).catch(() => []);
    console.log(`  [e2e] After merge: ${mergedFiles.filter(f => !f.startsWith('.')).join(', ') || '(none)'}`);

    // Post-merge actions (e.g., running tests for Tier 3)
    if (options?.postMerge) {
      await options.postMerge(repo.root);
    }

    // Verify files exist with expected content
    const verifyResult = await verifyFiles(repo.root, expectations);

    if (!verifyResult.passed) {
      const failures = verifyResult.details
        .filter(d => !d.exists || !d.contentOk)
        .map(d => d.message)
        .join('\n');
      throw new Error(`Verification failed:\n${failures}`);
    }

    console.log(`  [e2e] All ${expectations.length} file expectations passed`);

  } finally {
    if (process.env.OPENHIVE_KEEP_ARTIFACTS) {
      console.log(`  [e2e] Artifacts preserved:`);
      console.log(`  [e2e]   Repo: ${repo.root}`);
      console.log(`  [e2e]   Tmux: tmux attach -t openhive-orch`);
      console.log(`  [e2e]   Logs: ${repo.root}/.openhive/logs/`);
    } else {
      await repo.cleanup();
    }
  }
}

// ─── Tier 1: Simple file creation ────────────────────────────────────────────

describe.skipIf(!allAgentsAvailable(avail))('Tier 1: Simple file creation', () => {
  it('each agent creates a greeting file, branches merge cleanly', async () => {
    await runPipeline(
      [
        {
          id: 'tier1-claude',
          agent: 'claude',
          prompt: 'Create a file called claude-output.txt containing exactly the text "Hello from Claude" and nothing else. Do not create any other files.',
        },
        {
          id: 'tier1-codex',
          agent: 'codex',
          prompt: 'Create a file called codex-output.txt containing exactly the text "Hello from Codex" and nothing else. Do not create any other files.',
        },
        {
          id: 'tier1-gemini',
          agent: 'gemini',
          prompt: 'Create a file called gemini-output.txt containing exactly the text "Hello from Gemini" and nothing else. Do not create any other files.',
        },
      ],
      [
        { path: 'claude-output.txt', contains: 'Hello from Claude' },
        { path: 'codex-output.txt', contains: 'Hello from Codex' },
        { path: 'gemini-output.txt', contains: 'Hello from Gemini' },
      ],
    );
  });
});

// ─── Tier 2: Simple web page ─────────────────────────────────────────────────

describe.skipIf(!allAgentsAvailable(avail))('Tier 2: Simple web page', () => {
  it('three agents create HTML/CSS/JS that reference each other', async () => {
    await runPipeline(
      [
        {
          id: 'tier2-claude',
          agent: 'claude',
          prompt: [
            'Create a file called index.html with a valid HTML5 page.',
            'It must have a <link> tag referencing style.css and a <script> tag referencing script.js.',
            'The body must contain an element with id="title" containing "OpenHive Demo"',
            'and an element with id="output".',
            'Do not create any other files.',
          ].join(' '),
        },
        {
          id: 'tier2-codex',
          agent: 'codex',
          prompt: [
            'Create a file called style.css with CSS styles.',
            'It must include a rule for body (setting font-family),',
            'a rule for #title (setting color),',
            'and a rule for #output (setting padding).',
            'Do not create any other files.',
          ].join(' '),
        },
        {
          id: 'tier2-gemini',
          agent: 'gemini',
          prompt: [
            'Create a file called script.js with JavaScript.',
            'It must add a DOMContentLoaded event listener that sets',
            'the textContent of the element with id="output" to "Page loaded successfully".',
            'Do not create any other files.',
          ].join(' '),
        },
      ],
      [
        { path: 'index.html', contains: 'style.css' },
        { path: 'index.html', contains: 'script.js' },
        { path: 'index.html', contains: 'id="title"' },
        { path: 'index.html', contains: 'id="output"' },
        { path: 'style.css', matches: /#title/ },
        { path: 'style.css', matches: /#output/ },
        { path: 'script.js', contains: 'DOMContentLoaded' },
        { path: 'script.js', contains: 'output' },
      ],
    );
  });
});

// ─── Tier 3: REST API + tests ────────────────────────────────────────────────

describe.skipIf(!allAgentsAvailable(avail))('Tier 3: REST API with tests', () => {
  it('three agents build Express app + model + tests, all tests pass', async () => {
    await runPipeline(
      [
        {
          id: 'tier3-claude',
          agent: 'claude',
          prompt: [
            'Create src/app.js and src/routes.js for an Express REST API.',
            'src/app.js should create and export an Express app that uses the routes from src/routes.js.',
            'src/routes.js should define GET /items (returns JSON array), POST /items (adds item, returns 201),',
            'and GET /items/:id (returns single item or 404).',
            'Import the model from src/model.js (which exports { getAll, getById, add }).',
            'The app should listen on port 0 (random) when run directly, and export the app for testing.',
            'Do not create any other files.',
          ].join(' '),
        },
        {
          id: 'tier3-codex',
          agent: 'codex',
          prompt: [
            'Create src/model.js with an in-memory data store.',
            'Export three functions: getAll() returns all items as an array,',
            'getById(id) returns a single item or undefined,',
            'and add(item) adds an item (assign it a numeric id) and returns the new item.',
            'Each item should have at least { id, name } fields.',
            'Do not create any other files.',
          ].join(' '),
        },
        {
          id: 'tier3-gemini',
          agent: 'gemini',
          prompt: [
            'Create test/api.test.js with vitest tests for the Express API.',
            'Import the app from ../src/app.js.',
            'Use node:http to make requests (or import supertest if available).',
            'Test: GET /items returns 200 with an array,',
            'POST /items with { name: "test" } returns 201,',
            'GET /items/:id returns the created item.',
            'Use beforeAll to start the server and afterAll to close it.',
            'Do not create any other files.',
          ].join(' '),
        },
      ],
      [
        { path: 'src/app.js', contains: 'express' },
        { path: 'src/routes.js', contains: '/items' },
        { path: 'src/model.js', matches: /getAll|getById|add/ },
        { path: 'test/api.test.js', matches: /describe|it|test/ },
      ],
      {
        setupRepo: async (repo) => {
          // Initialize npm project and install dependencies
          console.log('  [e2e] Tier 3: setting up npm project...');
          await execFileAsync('npm', ['init', '-y'], { cwd: repo.root, timeout: 15_000 });
          await execFileAsync('npm', ['install', 'express'], { cwd: repo.root, timeout: 60_000 });
          await execFileAsync('npm', ['install', '-D', 'vitest'], { cwd: repo.root, timeout: 60_000 });

          // Create src directory
          await mkdir(join(repo.root, 'src'), { recursive: true });

          // Commit the package setup
          await git(repo.root, 'add', '-A');
          await git(repo.root, 'commit', '-m', 'npm init + express + vitest');
        },
        postMerge: async (repoRoot) => {
          // Run the tests after merge
          console.log('  [e2e] Tier 3: running tests...');
          const { stdout, stderr } = await execFileAsync(
            'npx', ['vitest', 'run'],
            { cwd: repoRoot, timeout: 60_000 },
          );
          console.log(`  [e2e] Test output:\n${stdout}`);
          if (stderr) console.log(`  [e2e] Test stderr:\n${stderr}`);
        },
      },
    );
  });
});
