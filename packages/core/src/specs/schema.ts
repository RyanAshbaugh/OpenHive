export interface ScreenshotSpec {
  /** URL to screenshot */
  url: string;
  /** Name for the screenshot file */
  name: string;
  /** Description of what the screenshot should show (for vision assessment) */
  expect: string;
}

export interface VerifyConfig {
  /** Command to run automated tests */
  tests?: string;
  /** Screenshots to take and assess */
  screenshots?: ScreenshotSpec[];
  /** Command template for taking screenshots. {url} and {output} are replaced. */
  screenshotCommand?: string;
}

export interface ServeConfig {
  /** Command to start the dev server */
  command: string;
  /** Port the server listens on (optional — use findFreePort() if omitted) */
  port?: number;
  /** Stdout pattern that indicates the server is ready */
  readyPattern?: string;
  /** Max time to wait for server startup in ms */
  startupTimeout?: number;
}

export interface TaskSpec {
  /** Unique task identifier within the spec */
  id: string;
  /** Human-readable task name */
  name: string;
  /** The prompt to send to the agent */
  prompt: string;
  /** Task IDs this task depends on */
  dependsOn?: string[];
  /** Preferred agent (optional — auto-select if omitted) */
  agent?: string;
}

export interface ProjectSpec {
  /** Project name */
  name: string;
  /** High-level project goal */
  goal: string;
  /** Dev server configuration for verification */
  serve?: ServeConfig;
  /** Task decomposition */
  tasks: TaskSpec[];
  /** Verification configuration */
  verify?: VerifyConfig;
}
