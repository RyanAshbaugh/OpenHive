# OpenHive Package Architecture

## Overview

OpenHive is structured as a **monorepo with workspace packages**. Each package is independently runnable and publishable, but they integrate seamlessly when used together through the OpenHive CLI.

## Packages

```
openhive/
├── packages/
│   ├── core/          # @openhive/core — orchestrator, agents, CLI
│   ├── mobile/        # @openhive/mobile — mobile simulation & testing
│   └── web/           # @openhive/web — browser-based testing
├── pnpm-workspace.yaml
└── package.json       # workspace root
```

### `@openhive/core`

The orchestrator. This is what exists today — multi-agent orchestration, task management, specs, scheduling, git worktrees, the `openhive` CLI.

- **Location:** `packages/core/`
- **Entry point:** `bin/openhive.mjs`
- **Contains:** agents, orchestrator, specs, scheduler, tasks, pool, git, config, verify (thin dispatcher to toolkit packages)

### `@openhive/mobile`

Mobile simulation, testing, and UI automation for iOS and Android.

- **Location:** `packages/mobile/`
- **Standalone CLI:** `bin/openhive-mobile`
- **Capabilities:**
  - Simulator/emulator management (boot, shutdown, list)
  - App build, install, and launch
  - UI automation (tap, swipe, type, wait for element)
  - Screenshot capture and video recording
  - Authentication helpers (keychain-based credential management, deep link auth flows)
  - Scene-based automation (declarative sequences of actions)
  - Test execution on simulators
- **Technologies:** Shell scripts, Python helpers, xcodebuild/simctl integration, xcodebuildmcp
- **Config-driven:** Each project provides a config file rather than hardcoding app-specific values

### `@openhive/web`

Browser-based testing, screenshot capture, and visual verification.

- **Location:** `packages/web/`
- **Standalone CLI:** `bin/openhive-web`
- **Capabilities:**
  - Browser automation (Playwright-based)
  - Screenshot capture at specified URLs/routes
  - Visual regression testing
  - Test execution in browser environments
- **Technologies:** TypeScript, Playwright

## Design Principles

### Independent by default

Each package can be used without the others:

```bash
# Use mobile toolkit directly, no openhive orchestrator needed
npx @openhive/mobile run --config mobile.json5

# Use web toolkit directly
npx @openhive/web screenshot --url http://localhost:3000
```

### Integrated when wanted

Core can depend on `@openhive/mobile` and `@openhive/web` as workspace dependencies. The verify system in core dispatches to the appropriate toolkit:

```typescript
// In core's verify module
if (verifyConfig.type === 'mobile') {
  await mobile.run(verifyConfig);
} else if (verifyConfig.type === 'web') {
  await web.run(verifyConfig);
}
```

An OpenHive spec can reference toolkits in its verify config:

```json5
{
  tasks: [
    {
      id: "build-feature",
      prompt: "Implement the login screen",
      verify: {
        type: "mobile",
        actions: ["launch", "login", "screenshot"],
        expect: "Login screen with email and password fields"
      }
    }
  ]
}
```

### Config-driven, not hardcoded

App-specific values live in config files, not baked into scripts. Example mobile config:

```json5
// .openhive/mobile.json5
{
  platform: "ios",
  bundleId: "com.example.myapp",
  deepLinkScheme: "myapp",
  simulator: {
    device: "iPhone 16 Pro",
    os: "18.2"
  },
  auth: {
    provider: "supabase",
    keychainService: "myapp-simulation",
    // No secrets in config — credentials stored in macOS Keychain
  },
  scenes: [
    {
      name: "onboarding",
      steps: ["launch", "screenshot"]
    },
    {
      name: "dashboard",
      steps: ["login", "navigate:/dashboard", "wait:2000", "screenshot"]
    }
  ]
}
```

### Polyglot-friendly

Packages don't have to be pure TypeScript. The mobile package contains shell scripts and Python — the `package.json` provides the entry point and metadata, and `bin/` scripts can invoke whatever runtime is appropriate.

## Workspace Setup

Root `pnpm-workspace.yaml`:

```yaml
packages:
  - 'packages/*'
```

Root `package.json`:

```json
{
  "private": true,
  "scripts": {
    "build": "pnpm -r build",
    "test": "pnpm -r test"
  }
}
```

Each package has its own `package.json` with its own dependencies, scripts, and bin entries.

## Migration Path

1. Add `pnpm-workspace.yaml` at root
2. Move current `src/`, `bin/`, `test/`, `tsconfig.json`, `vitest.config.ts` into `packages/core/`
3. Update imports and paths in core
4. Create `packages/mobile/` — extract and generalize simulation tools from habit-goal
5. Create `packages/web/` — extract screenshot/browser verification from core's verify module
6. Core's verify module becomes a thin dispatcher that delegates to mobile/web packages
7. Update root `package.json` for workspace scripts

## How This Fits the Bigger Picture

- **OpenHive** (open source) — the engine: orchestration, toolkits, verification
- **Auto-app** (commercial) — the platform: uses OpenHive under the hood, adds managed integrations (Apple Developer Portal, GitHub, Supabase, Railway), credential vaults, hosted workflows, and a web UI
- **Consumer apps** (e.g., habit-goal) — use `@openhive/mobile` for simulation and testing, configured via project-level config files
