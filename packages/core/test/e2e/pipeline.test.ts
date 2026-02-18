/**
 * E2E Pipeline Tests — Multi-agent orchestration with real agents.
 *
 * These tests exercise the REAL orchestrator path:
 *   Orchestrator → WorkerSession (tmux windows) → real agents in interactive mode
 *   → state detection → auto-approve → task completion detection
 *
 * Four tiers of increasing complexity:
 *   Tier 1: Simple file creation (~30-60s)
 *   Tier 2: Web page with HTML/CSS/JS (~60-120s)
 *   Tier 3: REST API + tests (~2-5min)
 *   Tier 4: Web app with screenshot verification (~3-8min)
 *
 * All tiers skip automatically if agents are not installed.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { type ChildProcess } from 'node:child_process';

import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { createTask } from '../../src/tasks/task.js';
import { TaskStorage } from '../../src/tasks/storage.js';
import type { OrchestratorEvent } from '../../src/orchestrator/types.js';

import { checkAgentAvailability, allAgentsAvailable, unavailableSummary, checkPlaywrightAvailable } from './helpers/agent-check.js';
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

    // Create task storage for persisting task state to the global dir
    const taskStorage = new TaskStorage(join(homedir(), '.openhive', 'tasks'));

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
        taskTimeoutMs: 240_000, // 4 min hard wall-clock deadline per task
        llmEscalationTimeoutMs: 60_000, // 1 min timeout for LLM escalation calls
      },
      taskStorage,
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
  it('each agent creates a greeting file, branches merge cleanly', { timeout: 600_000 }, async () => {
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
  it('three agents create HTML/CSS/JS that reference each other', { timeout: 600_000 }, async () => {
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
  it('three agents build Express app + model + tests, all tests pass', { timeout: 600_000 }, async () => {
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

          // Write vitest config that excludes worktree directories from test discovery
          await writeFile(
            join(repo.root, 'vitest.config.js'),
            [
              'import { defineConfig } from "vitest/config";',
              'export default defineConfig({',
              '  test: {',
              '    exclude: [".openhive-worktrees/**", "node_modules/**"],',
              '  },',
              '});',
            ].join('\n'),
          );

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

// ─── Tier 4: Web app with screenshot verification ─────────────────────────

// Tier 4 additionally requires Playwright for screenshots
const playwrightAvailable = await checkPlaywrightAvailable();

if (allAgentsAvailable(avail) && !playwrightAvailable) {
  console.log('Skipping Tier 4: Playwright not available (install with: npm install -D playwright && npx playwright install chromium)');
}

describe.skipIf(!allAgentsAvailable(avail) || !playwrightAvailable)('Tier 4: Web app with screenshot verification', () => {
  it('agents build a task board app in waves, screenshots verify UI', { timeout: 900_000 }, async () => {
    // Lazy imports for Tier 4 only
    const { runSpecOrchestrated } = await import('../../src/orchestrator/spec-runner.js');
    const { findFreePort, waitForPort } = await import('../../src/utils/port.js');
    const { takeScreenshot } = await import('../../src/verify/screenshot.js');
    const { exec, spawnProcess } = await import('../../src/utils/process.js');
    const { TaskStorage } = await import('../../src/tasks/storage.js');

    const repo = await createTestRepo();
    let serverProcess: ChildProcess | undefined;

    try {
      // ── Spec definition ──────────────────────────────────────────────
      const spec = {
        name: 'Task Board',
        goal: 'Build a multi-page task board web app with navigation',
        tasks: [
          {
            id: 'tier4-server',
            name: 'HTTP Server',
            agent: 'claude',
            prompt: [
              'Create a file called server.js that implements a Node.js HTTP server using ONLY the built-in node:http and node:fs modules (no npm packages).',
              'The server must:',
              '- Listen on the port specified by process.env.PORT, or 3000 if not set',
              '- Serve static files from a "public/" directory relative to the script',
              '- Route "/" to public/index.html, "/add" to public/add.html, "/about" to public/about.html',
              '- Set correct Content-Type headers: text/html for .html, text/css for .css, application/javascript for .js',
              '- Return 404 for unknown routes',
              '- Log "Listening on port <PORT>" to stdout when ready',
              'Do not create any other files. Do not use Express or any npm packages.',
            ].join(' '),
          },
          {
            id: 'tier4-style',
            name: 'CSS Styling',
            agent: 'gemini',
            prompt: [
              'Create a file called public/style.css with CSS styles for a task board web app.',
              'It must include:',
              '- A nav bar style: dark background (#333), white text, horizontal links with padding',
              '- Body: sans-serif font, margin 0',
              '- A .container class with max-width and padding',
              '- Form input and button styling',
              '- A .task-list style for list items',
              'Do not create any other files.',
            ].join(' '),
          },
          {
            id: 'tier4-home',
            name: 'Home Page',
            agent: 'claude',
            dependsOn: ['tier4-server'],
            prompt: [
              'Create a file called public/index.html for a task board home page.',
              'It must include:',
              '- A <link> to style.css and a <script src="app.js" defer>',
              '- A <nav> bar with links: Home (/), Add Task (/add), About (/about)',
              '- An <h1> with text "Task Board"',
              '- A <div id="task-list"> where tasks will be rendered by app.js',
              '- A <p id="empty-state"> with text "No tasks yet" (shown when list is empty)',
              'Do not create any other files.',
            ].join(' '),
          },
          {
            id: 'tier4-add',
            name: 'Add Task Page + JS',
            agent: 'codex',
            dependsOn: ['tier4-server'],
            prompt: [
              'Create two files: public/add.html and public/app.js.',
              '',
              'public/add.html must include:',
              '- A <link> to style.css and a <script src="app.js" defer>',
              '- A <nav> bar with links: Home (/), Add Task (/add), About (/about)',
              '- An <h1> with text "Add Task"',
              '- A <form id="task-form"> with a text <input id="task-input" placeholder="Enter task..."> and a <button type="submit">Add</button>',
              '',
              'public/app.js must include:',
              '- Functions to load/save tasks from localStorage (key: "tasks", JSON array of strings)',
              '- On the add page: handle form submit to add the input value to the tasks array in localStorage, then redirect to "/"',
              '- On the home page: render tasks from localStorage into #task-list as <li> elements, hide #empty-state if tasks exist',
              'Do not create any other files.',
            ].join(' '),
          },
          {
            id: 'tier4-about',
            name: 'About Page',
            agent: 'gemini',
            dependsOn: ['tier4-style'],
            prompt: [
              'Create a file called public/about.html for the About page of a task board app.',
              'It must include:',
              '- A <link> to style.css',
              '- A <nav> bar with links: Home (/), Add Task (/add), About (/about)',
              '- An <h1> with text "About Task Board"',
              '- A <p> with a descriptive paragraph about the app (e.g. "Task Board is a simple web application for managing your tasks.")',
              'Do not create any other files.',
            ].join(' '),
          },
        ],
      };

      // ── Run spec orchestrated (wave-based dispatch) ──────────────────
      console.log('  [e2e] Tier 4: running spec with 2 waves (5 tasks)...');

      const taskStorage = new TaskStorage(join(homedir(), '.openhive', 'tasks'));
      const specResult = await runSpecOrchestrated(spec, {
        config: {
          maxWorkers: 3,
          autoApprove: true,
          tickIntervalMs: 2000,
          useWorktrees: true,
          worktreeDir: '.openhive-worktrees',
          repoRoot: repo.root,
          idleSettlingMs: 3000,
          stuckTimeoutMs: 180_000,
          taskTimeoutMs: 300_000, // 5 min per task — Tier 4 tasks are more complex
          llmEscalationTimeoutMs: 60_000,
        },
        taskStorage,
        onEvent: (e) => {
          if (e.type === 'task_completed' || e.type === 'task_failed') {
            console.log(`  [e2e] ${e.type}: ${e.taskId}`);
          }
        },
      });

      // Verify all waves succeeded
      if (!specResult.success) {
        const failedTasks = specResult.waves
          .flatMap(w => w.failed)
          .join(', ');
        throw new Error(`Spec execution failed. Failed tasks: ${failedTasks}`);
      }

      console.log(`  [e2e] Tier 4: all ${spec.tasks.length} tasks completed in ${specResult.waves.length} waves`);

      // ── Force-commit and merge worktrees ──────────────────────────────
      const branches: string[] = [];
      for (const task of spec.tasks) {
        const worktreePath = join(repo.root, '.openhive-worktrees', task.id);
        try {
          const files = await readdir(worktreePath).catch(() => []);
          console.log(`  [e2e] Worktree ${task.id} files: ${files.filter(f => !f.startsWith('.')).join(', ') || '(none)'}`);

          const branch = await forceCommitWorktree(
            worktreePath,
            `[openhive] ${task.agent} completed task ${task.id}`,
          );
          branches.push(branch);
          console.log(`  [e2e] Committed worktree: ${branch}`);
        } catch (err) {
          console.warn(`  [e2e] Warning: could not commit worktree for ${task.id}: ${err}`);
        }
      }

      await git(repo.root, 'checkout', 'main');
      console.log(`  [e2e] Merging ${branches.length} branches to main...`);
      const mergeResult = await mergeAllBranches(repo.root, branches);

      if (!mergeResult.success) {
        const failedBranches = mergeResult.failed.map(f => `${f.branch}: ${f.error}`).join('; ');
        throw new Error(`Merge failed for: ${failedBranches}`);
      }

      // List files after merge
      const mergedFiles = await readdir(repo.root).catch(() => []);
      console.log(`  [e2e] After merge: ${mergedFiles.filter(f => !f.startsWith('.')).join(', ') || '(none)'}`);
      const publicFiles = await readdir(join(repo.root, 'public')).catch(() => []);
      console.log(`  [e2e] public/: ${publicFiles.join(', ') || '(none)'}`);

      // ── File content verification ─────────────────────────────────────
      const fileExpectations: FileExpectation[] = [
        { path: 'server.js', contains: 'createServer' },
        { path: 'server.js', matches: /process\.env\.PORT/ },
        { path: 'public/style.css', matches: /nav|\.nav/ },
        { path: 'public/index.html', contains: 'Task Board' },
        { path: 'public/index.html', matches: /nav/i },
        { path: 'public/add.html', matches: /form|input/i },
        { path: 'public/add.html', matches: /nav/i },
        { path: 'public/app.js', contains: 'localStorage' },
        { path: 'public/about.html', contains: 'About Task Board' },
        { path: 'public/about.html', matches: /nav/i },
      ];

      const verifyResult = await verifyFiles(repo.root, fileExpectations);
      if (!verifyResult.passed) {
        const failures = verifyResult.details
          .filter(d => !d.exists || !d.contentOk)
          .map(d => d.message)
          .join('\n');
        throw new Error(`File verification failed:\n${failures}`);
      }
      console.log(`  [e2e] All ${fileExpectations.length} file expectations passed`);

      // ── Start server + screenshot verification ────────────────────────
      const port = await findFreePort();
      console.log(`  [e2e] Starting server on port ${port}...`);

      serverProcess = spawnProcess('node', ['server.js'], {
        cwd: repo.root,
        env: { PORT: String(port) },
      });

      // Capture server output for diagnostics
      let serverStdout = '';
      let serverStderr = '';
      serverProcess.stdout?.on('data', (d: Buffer) => { serverStdout += d.toString(); });
      serverProcess.stderr?.on('data', (d: Buffer) => { serverStderr += d.toString(); });

      // Wait for port to accept connections
      await waitForPort(port, { timeoutMs: 15_000 });
      console.log(`  [e2e] Server is listening on port ${port}`);

      // Take screenshots
      const screenshotDir = join(repo.root, '.openhive', 'screenshots');
      const baseUrl = `http://127.0.0.1:${port}`;

      const screenshotSpecs = [
        {
          name: 'home',
          url: `${baseUrl}/`,
          expect: 'Navigation bar with links. Heading "Task Board". Either a task list or "No tasks" message.',
        },
        {
          name: 'add-task',
          url: `${baseUrl}/add`,
          expect: 'Navigation bar. Form with text input and submit button for adding tasks.',
        },
        {
          name: 'about',
          url: `${baseUrl}/about`,
          expect: 'Navigation bar. Heading "About Task Board" with descriptive paragraph.',
        },
      ];

      const screenshotResults = [];
      for (const ss of screenshotSpecs) {
        console.log(`  [e2e] Taking screenshot: ${ss.name} (${ss.url})`);
        const result = await takeScreenshot({
          url: ss.url,
          name: ss.name,
          outputDir: screenshotDir,
        });
        screenshotResults.push({ ...ss, result });

        if (result.success) {
          console.log(`  [e2e] Screenshot saved: ${result.path}`);
        } else {
          console.error(`  [e2e] Screenshot FAILED: ${result.error}`);
        }
      }

      // Screenshots are mandatory — fail if any couldn't be captured
      const failedScreenshots = screenshotResults.filter(s => !s.result.success);
      if (failedScreenshots.length > 0) {
        const errors = failedScreenshots
          .map(s => `  ${s.name}: ${s.result.error}`)
          .join('\n');
        throw new Error(`Screenshot capture failed (mandatory):\n${errors}`);
      }

      console.log(`  [e2e] All ${screenshotResults.length} screenshots captured successfully`);

      // Vision assessment — run claude with each screenshot for LLM evaluation
      // Failures are warnings (logged but don't fail the test)
      for (const ss of screenshotResults) {
        try {
          const visionPrompt = [
            `Look at this screenshot of ${ss.url}.`,
            `Expected: ${ss.expect}`,
            'Does the screenshot match the expected content? Reply PASS or FAIL then explain briefly.',
          ].join(' ');

          const visionResult = await exec('claude', [
            '-p', visionPrompt,
            '--file', ss.result.path,
          ], { timeout: 60_000 });

          const output = visionResult.stdout.trim();
          const passed = /^PASS/i.test(output);

          if (passed) {
            console.log(`  [e2e] Vision assessment ${ss.name}: PASS`);
          } else {
            console.warn(`  [e2e] Vision assessment ${ss.name}: FAIL (warning only)`);
            console.warn(`  [e2e]   ${output.slice(0, 200)}`);
          }
        } catch (err) {
          console.warn(`  [e2e] Vision assessment ${ss.name}: error (warning only): ${err}`);
        }
      }

      console.log(`  [e2e] Screenshot directory: ${screenshotDir}`);

    } finally {
      // Kill server process
      if (serverProcess && !serverProcess.killed) {
        serverProcess.kill();
      }

      if (process.env.OPENHIVE_KEEP_ARTIFACTS) {
        console.log('  [e2e] Artifacts preserved:');
        console.log(`  [e2e]   Repo: ${repo.root}`);
        console.log(`  [e2e]   Screenshots: ${join(repo.root, '.openhive', 'screenshots')}`);
        if (serverProcess && !serverProcess.killed) {
          console.log(`  [e2e]   Server: http://127.0.0.1:${(serverProcess as any)._port ?? '?'}`);
        }
        console.log('  [e2e]   Tmux: tmux attach -t openhive-orch');
      } else {
        await repo.cleanup();
      }
    }
  });
});
