import { readFile } from 'node:fs/promises';
import JSON5 from 'json5';
import type { ProjectSpec } from './schema.js';

export class SpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecParseError';
  }
}

/** Load and validate a project spec from a JSON5 file */
export async function parseSpec(filePath: string): Promise<ProjectSpec> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new SpecParseError(`Cannot read spec file: ${filePath}`);
  }

  let data: unknown;
  try {
    data = JSON5.parse(raw);
  } catch (err) {
    throw new SpecParseError(`Invalid JSON5 in spec file: ${err instanceof Error ? err.message : String(err)}`);
  }

  return validateSpec(data);
}

/** Validate parsed data against the ProjectSpec schema */
export function validateSpec(data: unknown): ProjectSpec {
  if (!data || typeof data !== 'object') {
    throw new SpecParseError('Spec must be a JSON object');
  }

  const spec = data as Record<string, unknown>;

  // Required fields
  if (typeof spec.name !== 'string' || !spec.name) {
    throw new SpecParseError('Spec must have a "name" string');
  }
  if (typeof spec.goal !== 'string' || !spec.goal) {
    throw new SpecParseError('Spec must have a "goal" string');
  }
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) {
    throw new SpecParseError('Spec must have a non-empty "tasks" array');
  }

  // Validate tasks
  const taskIds = new Set<string>();
  for (const task of spec.tasks) {
    if (!task || typeof task !== 'object') {
      throw new SpecParseError('Each task must be an object');
    }
    const t = task as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id) {
      throw new SpecParseError('Each task must have an "id" string');
    }
    if (typeof t.name !== 'string' || !t.name) {
      throw new SpecParseError(`Task "${t.id}" must have a "name" string`);
    }
    if (typeof t.prompt !== 'string' || !t.prompt) {
      throw new SpecParseError(`Task "${t.id}" must have a "prompt" string`);
    }
    if (taskIds.has(t.id)) {
      throw new SpecParseError(`Duplicate task id: "${t.id}"`);
    }
    taskIds.add(t.id);

    if (t.dependsOn !== undefined) {
      if (!Array.isArray(t.dependsOn)) {
        throw new SpecParseError(`Task "${t.id}" dependsOn must be an array`);
      }
      for (const dep of t.dependsOn) {
        if (typeof dep !== 'string') {
          throw new SpecParseError(`Task "${t.id}" dependsOn entries must be strings`);
        }
      }
    }

    if (t.agent !== undefined && typeof t.agent !== 'string') {
      throw new SpecParseError(`Task "${t.id}" agent must be a string`);
    }
  }

  // Validate dependsOn references exist
  for (const task of spec.tasks) {
    const t = task as Record<string, unknown>;
    if (Array.isArray(t.dependsOn)) {
      for (const dep of t.dependsOn) {
        if (!taskIds.has(dep as string)) {
          throw new SpecParseError(`Task "${t.id}" depends on unknown task "${dep}"`);
        }
      }
    }
  }

  // Validate serve config if present
  if (spec.serve !== undefined) {
    if (!spec.serve || typeof spec.serve !== 'object') {
      throw new SpecParseError('"serve" must be an object');
    }
    const serve = spec.serve as Record<string, unknown>;
    if (typeof serve.command !== 'string' || !serve.command) {
      throw new SpecParseError('serve.command must be a non-empty string');
    }
    if (typeof serve.port !== 'number' || serve.port <= 0) {
      throw new SpecParseError('serve.port must be a positive number');
    }
  }

  // Validate verify config if present
  if (spec.verify !== undefined) {
    if (!spec.verify || typeof spec.verify !== 'object') {
      throw new SpecParseError('"verify" must be an object');
    }
    const verify = spec.verify as Record<string, unknown>;

    if (verify.tests !== undefined && typeof verify.tests !== 'string') {
      throw new SpecParseError('verify.tests must be a string');
    }

    if (verify.screenshots !== undefined) {
      if (!Array.isArray(verify.screenshots)) {
        throw new SpecParseError('verify.screenshots must be an array');
      }
      for (const ss of verify.screenshots) {
        if (!ss || typeof ss !== 'object') {
          throw new SpecParseError('Each screenshot spec must be an object');
        }
        const s = ss as Record<string, unknown>;
        if (typeof s.url !== 'string' || !s.url) {
          throw new SpecParseError('Each screenshot must have a "url" string');
        }
        if (typeof s.name !== 'string' || !s.name) {
          throw new SpecParseError('Each screenshot must have a "name" string');
        }
        if (typeof s.expect !== 'string' || !s.expect) {
          throw new SpecParseError('Each screenshot must have an "expect" string');
        }
      }
    }
  }

  return data as ProjectSpec;
}
