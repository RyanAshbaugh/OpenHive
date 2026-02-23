/**
 * Configuration schema for @openhive/mobile.
 *
 * Projects provide their settings in `.openhive/mobile.json5` (or the path
 * set in $OPENHIVE_MOBILE_CONFIG).  Every field is optional — sensible
 * defaults are applied by the loader.
 */

export interface MobileConfig {
  /** Application identifiers */
  app: {
    /** iOS bundle identifier (e.g. "com.example.myapp") */
    bundleId: string;
    /** Deep-link scheme used by the app (e.g. "myapp") */
    deepLinkScheme: string;
    /** Expo dev-client scheme, if using Expo (e.g. "exp+myapp") */
    expoDevClientScheme?: string;
    /** Metro bundler port */
    metroPort: number;
    /** Human-readable app name (used in log output) */
    appName: string;
  };

  /** Simulator settings */
  simulator: {
    /** Simulator device name (e.g. "iPhone 17 Pro") */
    device: string;
    /** iOS version string (e.g. "26.2") */
    os: string;
  };

  /** Xcode build settings */
  build: {
    /** Path to .xcworkspace (relative to project root) */
    workspace: string;
    /** Xcode scheme name */
    scheme: string;
    /** Build configuration */
    configuration: string;
  };

  /** Authentication settings for automated sign-in */
  auth: {
    /** Auth provider type */
    provider: 'supabase' | 'firebase' | 'custom';
    /** macOS Keychain service name for stored credentials */
    keychainService: string;
    /** Path to env file with API keys (relative to project root) */
    envFile: string;
    /** Env var name for the API URL */
    urlEnvVar: string;
    /** Env var name for the API key / anon key */
    keyEnvVar: string;
  };

  /** AI agent settings for code generation */
  agent?: {
    /** CLI command to invoke (default: "claude") */
    cli: string;
  };

  /**
   * Lifecycle hooks — scripts sourced at specific points during build/run.
   * Each value is a script path relative to $PROJECT_DIR.
   * Scripts are `source`d (not exec'd) so they have access to all env vars
   * and helper functions (tap_button, screenshot, etc.).
   */
  hooks?: {
    /** After xcodebuild completes */
    postBuild?: string;
    /** After simulator boots */
    postBoot?: string;
    /** After app is installed */
    postInstall?: string;
    /** After app launches + dialogs dismissed */
    postLaunch?: string;
    /** After authentication completes */
    postAuth?: string;
    /** After the entire setup flow finishes */
    postSetup?: string;
  };
}
