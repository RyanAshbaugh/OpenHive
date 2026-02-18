# @openhive/mobile

Mobile simulator automation tools for OpenHive. Provides config-driven scripts for building, launching, and authenticating iOS apps on the simulator.

## Quick Start

1. Create a config file at `.openhive/mobile.json5` in your project root:

```json5
{
  app: {
    bundleId: "com.mycompany.myapp",
    deepLinkScheme: "myapp",
    expoDevClientScheme: "exp+myapp",
    metroPort: 8081,
    appName: "MyApp",
  },
  simulator: {
    device: "iPhone 16 Pro",
    os: "18.2",
  },
  build: {
    workspace: "ios/MyApp.xcworkspace",
    scheme: "MyApp",
    configuration: "Debug",
  },
  auth: {
    provider: "supabase",
    keychainService: "myapp-simulation",
    envFile: ".env.development",
    urlEnvVar: "SUPABASE_URL",
    keyEnvVar: "SUPABASE_ANON_KEY",
  },
}
```

2. Store test credentials:

```bash
openhive-mobile creds
```

3. Build, launch, and authenticate:

```bash
openhive-mobile run
```

## Commands

| Command | Description |
|---------|-------------|
| `openhive-mobile run` | Full flow: build + launch + authenticate |
| `openhive-mobile run --skip-build` | Use cached Xcode build |
| `openhive-mobile run --skip-auth` | Skip authentication step |
| `openhive-mobile auth` | Authenticate on running simulator |
| `openhive-mobile creds` | Interactive credential setup |
| `openhive-mobile creds --verify` | Test credentials against API |
| `openhive-mobile creds --delete` | Remove stored credentials |

## Environment Overrides

Environment variables take priority over the config file:

- `PROJECT_DIR` — Project root (default: cwd)
- `SIM_NAME` — Simulator device name
- `SIM_RUNTIME` — iOS version
- `METRO_PORT` — Metro bundler port
- `OPENHIVE_MOBILE_CONFIG` — Config file path (relative to project root)

## Shell Helpers

Source the helpers for interactive use:

```bash
source packages/mobile/scripts/sim-helpers.sh
screenshot "my-screenshot"
list_ui_elements
tap_button "Continue"
```
