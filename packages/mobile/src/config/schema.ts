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
}
