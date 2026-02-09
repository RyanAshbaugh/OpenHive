import type { AgentRegistry } from '../agents/registry.js';
import type { OpenHiveConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export interface AssessmentResult {
  /** Whether the screenshot matches the expected description */
  passed: boolean;
  /** Agent's explanation of why it passed or failed */
  explanation: string;
  /** Agent used for assessment */
  agent: string;
}

/** Find the first vision-capable agent from the registry */
export function findVisionAgent(
  registry: AgentRegistry,
  config: OpenHiveConfig,
): string | null {
  const available = registry.getAvailable(config);
  // Prefer Claude for vision assessment
  const preferred = ['claude', 'gemini', 'cursor'];
  for (const name of preferred) {
    const agent = available.find(a => a.name === name && a.capabilities.vision);
    if (agent) return agent.name;
  }
  // Fall back to any vision-capable agent
  const visionAgent = available.find(a => a.capabilities.vision);
  return visionAgent?.name ?? null;
}

/** Assess a screenshot against an expected description using a vision-capable agent */
export async function assessScreenshot(options: {
  screenshotPath: string;
  url: string;
  expectedDescription: string;
  registry: AgentRegistry;
  config: OpenHiveConfig;
}): Promise<AssessmentResult> {
  const { screenshotPath, url, expectedDescription, registry, config } = options;

  const agentName = findVisionAgent(registry, config);
  if (!agentName) {
    return {
      passed: false,
      explanation: 'No vision-capable agent available for screenshot assessment',
      agent: 'none',
    };
  }

  const agent = registry.get(agentName);
  if (!agent) {
    return {
      passed: false,
      explanation: `Agent "${agentName}" not found in registry`,
      agent: agentName,
    };
  }

  const prompt = [
    `Look at this screenshot of ${url}.`,
    `The expected result is: ${expectedDescription}`,
    `Does the screenshot match the expected description?`,
    `Reply with PASS or FAIL on the first line, followed by a brief explanation.`,
  ].join(' ');

  logger.info(`Assessing screenshot with ${agentName}: ${screenshotPath}`);

  try {
    const result = await agent.run({
      prompt,
      cwd: process.cwd(),
      contextFiles: [screenshotPath],
    });

    const output = result.stdout.trim();
    const firstLine = output.split('\n')[0].toUpperCase();
    const passed = firstLine.includes('PASS');
    const explanation = output;

    return { passed, explanation, agent: agentName };
  } catch (err) {
    logger.error(`Assessment failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      passed: false,
      explanation: `Assessment error: ${err instanceof Error ? err.message : String(err)}`,
      agent: agentName,
    };
  }
}
