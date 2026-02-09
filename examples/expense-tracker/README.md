# Expense Tracker Dashboard — OpenHive Deep Example

A full-stack web app complex enough to genuinely need a hive. 9 tasks across 4 waves of parallelism.

## Why This Example?

Most "hello world" multi-agent demos are one-agent jobs pretending to be parallel. This example is different — it has real dependency chains and real parallelism:

```
Wave 1: scaffold                              (1 agent)
Wave 2: data-model + auth                     (2 agents in parallel)
Wave 3: expense-api + category-api            (2 agents in parallel)
Wave 4: dashboard-ui + expense-forms + auth-ui + tests  (4 agents in parallel)
Verify: npm test + 3 screenshots
```

Peak parallelism: **4 agents simultaneously**. A single agent would do these 9 tasks sequentially. The hive does waves 2-4 in parallel, cutting wall-clock time significantly.

## The Spec Format

The spec file (`spec.json5`) has four sections:

### 1. Metadata
```json5
{
  name: "Expense Tracker Dashboard",
  goal: "Full-stack expense tracker with auth, API, charts, and forms",
}
```

### 2. Serve Config
How to start the app for visual verification:
```json5
{
  serve: {
    command: "npm run dev",
    port: 3000,
    readyPattern: "listening on",  // stdout line that means server is ready
    startupTimeout: 15000,
  },
}
```

### 3. Tasks
Each task has an `id`, `prompt`, optional `dependsOn` array, and optional `agent` preference:

```json5
{
  tasks: [
    { id: "scaffold", name: "...", prompt: "..." },
    { id: "data-model", dependsOn: ["scaffold"], agent: "claude", ... },
    { id: "auth", dependsOn: ["scaffold"], agent: "codex", ... },
  ]
}
```

**Good task boundaries** split at interface points — "scaffold" creates the project, "data-model" creates the database, "expense-api" creates the REST layer. Each agent can work in isolation because the interface (file paths, function signatures) is specified in the prompt.

### 4. Verification
The critical piece — agents say "done" but how do you know it works?

```json5
{
  verify: {
    tests: "npm test",
    screenshots: [
      { url: "http://localhost:3000/login", name: "login-page", expect: "..." },
      { url: "http://localhost:3000/dashboard", name: "dashboard", expect: "..." },
    ],
  },
}
```

OpenHive runs the tests, starts the dev server, takes headless Playwright screenshots, and sends each screenshot to a vision-capable agent (Claude) with the `expect` string. The agent replies PASS or FAIL with an explanation.

Screenshots are saved to `.openhive/screenshots/` for manual review.

## Task Dependency Graph

```
scaffold ─┬─ data-model ─┬─ expense-api ─┬─ dashboard-ui
           │               │               ├─ expense-forms (also needs category-api)
           │               └─ category-api ─┘
           └─ auth ────────┬─ auth-ui
                           └─ tests (also needs expense-api, category-api)
```

## Running It

### Quick start
```bash
node examples/expense-tracker/run.mjs /path/to/empty-dir
```

This will:
1. Initialize the target directory with `git init` and `npm init`
2. Copy the spec into `.openhive/spec.json5`
3. Run `openhive launch`
4. Print results

### Manual
```bash
# Preview the execution plan
openhive launch --dry-run examples/expense-tracker/spec.json5

# Run for real
cd /path/to/target-dir
cp /path/to/examples/expense-tracker/spec.json5 .openhive/spec.json5
openhive launch

# Skip verification (just run tasks)
openhive launch --skip-verify
```

## What Gets Built

| Component | Tech | Files |
|-----------|------|-------|
| Server | Express.js | `src/server.js` |
| Database | better-sqlite3 | `src/db/` |
| Auth | Session cookies | `src/auth/`, `src/routes/auth.js` |
| Expense API | REST | `src/routes/expenses.js` |
| Category API | REST | `src/routes/categories.js` |
| Dashboard | EJS + Chart.js | `src/views/dashboard.ejs` |
| Forms | Modal + JS | `src/views/partials/`, `src/public/js/` |
| Tests | Vitest + Supertest | `test/` |

## Verification Points

| Screen | What We Check |
|--------|--------------|
| Login (`/login`) | Styled login form with email/password fields, register link |
| Dashboard (`/dashboard`) | Expense chart, monthly total card, recent expenses table |
| Add Expense (modal) | Form with amount, description, category dropdown, date picker |

## Design Decisions

- **Dummy auth** — hardcoded `test@test.com` / `password`. No Supabase, no OAuth. Just enough to demonstrate login flow and protected routes.
- **SQLite** — zero config, single file database. No need for Postgres or Docker.
- **EJS** — server-side rendering keeps things simple. No React/Vue build step.
- **Chart.js via CDN** — no bundler needed.
- **Headless Playwright** — screenshots run in background, no browser window opens on your display.
