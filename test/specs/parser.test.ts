import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateSpec, SpecParseError } from '../../src/specs/parser.js';

describe('validateSpec', () => {
  const minimalSpec = {
    name: 'Test Project',
    goal: 'Build something',
    tasks: [
      { id: 'task-1', name: 'First Task', prompt: 'Do the first thing' },
    ],
  };

  it('should accept a minimal valid spec', () => {
    const result = validateSpec(minimalSpec);
    expect(result.name).toBe('Test Project');
    expect(result.goal).toBe('Build something');
    expect(result.tasks).toHaveLength(1);
  });

  it('should accept a full spec with all optional fields', () => {
    const fullSpec = {
      name: 'Full Project',
      goal: 'Build everything',
      serve: {
        command: 'npm run dev',
        port: 3000,
        readyPattern: 'listening',
        startupTimeout: 10000,
      },
      tasks: [
        { id: 'a', name: 'Task A', prompt: 'Do A' },
        { id: 'b', name: 'Task B', prompt: 'Do B', dependsOn: ['a'], agent: 'claude' },
      ],
      verify: {
        tests: 'npm test',
        screenshots: [
          { url: 'http://localhost:3000', name: 'home', expect: 'A homepage' },
        ],
        screenshotCommand: 'npx playwright screenshot {url} {output}',
      },
    };

    const result = validateSpec(fullSpec);
    expect(result.name).toBe('Full Project');
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[1].dependsOn).toEqual(['a']);
    expect(result.verify?.screenshots).toHaveLength(1);
  });

  it('should reject non-object input', () => {
    expect(() => validateSpec(null)).toThrow(SpecParseError);
    expect(() => validateSpec('string')).toThrow(SpecParseError);
    expect(() => validateSpec(42)).toThrow(SpecParseError);
  });

  it('should require name', () => {
    expect(() => validateSpec({ goal: 'x', tasks: [{ id: 'a', name: 'A', prompt: 'p' }] }))
      .toThrow('must have a "name"');
  });

  it('should require goal', () => {
    expect(() => validateSpec({ name: 'x', tasks: [{ id: 'a', name: 'A', prompt: 'p' }] }))
      .toThrow('must have a "goal"');
  });

  it('should require non-empty tasks array', () => {
    expect(() => validateSpec({ name: 'x', goal: 'y', tasks: [] }))
      .toThrow('non-empty "tasks"');
  });

  it('should require task id', () => {
    expect(() => validateSpec({
      name: 'x', goal: 'y',
      tasks: [{ name: 'A', prompt: 'p' }],
    })).toThrow('must have an "id"');
  });

  it('should require task name', () => {
    expect(() => validateSpec({
      name: 'x', goal: 'y',
      tasks: [{ id: 'a', prompt: 'p' }],
    })).toThrow('must have a "name"');
  });

  it('should require task prompt', () => {
    expect(() => validateSpec({
      name: 'x', goal: 'y',
      tasks: [{ id: 'a', name: 'A' }],
    })).toThrow('must have a "prompt"');
  });

  it('should reject duplicate task ids', () => {
    expect(() => validateSpec({
      name: 'x', goal: 'y',
      tasks: [
        { id: 'a', name: 'A', prompt: 'p' },
        { id: 'a', name: 'B', prompt: 'q' },
      ],
    })).toThrow('Duplicate task id');
  });

  it('should reject unknown dependency references', () => {
    expect(() => validateSpec({
      name: 'x', goal: 'y',
      tasks: [
        { id: 'a', name: 'A', prompt: 'p', dependsOn: ['nonexistent'] },
      ],
    })).toThrow('depends on unknown task');
  });

  it('should validate serve config requires command and port', () => {
    expect(() => validateSpec({
      name: 'x', goal: 'y',
      tasks: [{ id: 'a', name: 'A', prompt: 'p' }],
      serve: { port: 3000 },
    })).toThrow('serve.command');

    expect(() => validateSpec({
      name: 'x', goal: 'y',
      tasks: [{ id: 'a', name: 'A', prompt: 'p' }],
      serve: { command: 'npm dev', port: -1 },
    })).toThrow('serve.port');
  });

  it('should validate screenshot entries', () => {
    expect(() => validateSpec({
      name: 'x', goal: 'y',
      tasks: [{ id: 'a', name: 'A', prompt: 'p' }],
      verify: {
        screenshots: [{ name: 'home', expect: 'stuff' }], // missing url
      },
    })).toThrow('"url"');

    expect(() => validateSpec({
      name: 'x', goal: 'y',
      tasks: [{ id: 'a', name: 'A', prompt: 'p' }],
      verify: {
        screenshots: [{ url: 'http://x', expect: 'stuff' }], // missing name
      },
    })).toThrow('"name"');

    expect(() => validateSpec({
      name: 'x', goal: 'y',
      tasks: [{ id: 'a', name: 'A', prompt: 'p' }],
      verify: {
        screenshots: [{ url: 'http://x', name: 'home' }], // missing expect
      },
    })).toThrow('"expect"');
  });
});
