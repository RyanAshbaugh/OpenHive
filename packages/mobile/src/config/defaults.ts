import type { MobileConfig } from './schema.js';

/**
 * Default configuration values.  Every field has a sensible fallback so
 * consumers only need to override what differs from these defaults.
 */
export const defaults: MobileConfig = {
  app: {
    bundleId: 'com.example.app',
    deepLinkScheme: 'myapp',
    expoDevClientScheme: undefined,
    metroPort: 8081,
    appName: 'MyApp',
  },
  simulator: {
    device: 'iPhone 16 Pro',
    os: '18.2',
  },
  build: {
    workspace: 'ios/MyApp.xcworkspace',
    scheme: 'MyApp',
    configuration: 'Debug',
  },
  auth: {
    provider: 'supabase',
    keychainService: 'openhive-mobile-sim',
    envFile: '.env.development',
    urlEnvVar: 'SUPABASE_URL',
    keyEnvVar: 'SUPABASE_ANON_KEY',
  },
  hooks: {},
};
