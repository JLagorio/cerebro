// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The trace steps' stylesheet (M91.9a), read from the shipped file, held to
 * the foundation's rules (styles.test.ts): DS tokens only, and no motion of
 * its own — the foundation's collapsible and running light are the steps'
 * motion. And every class the steps draw with is a class some stylesheet
 * defines, so a renamed rule cannot leave a step unstyled.
 */

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const CSS = strip(read('trace-steps.css'));
const STEPS = [
  'StepLine.tsx',
  'ChainOfThought.tsx',
  'Reasoning.tsx',
  'Tool.tsx',
  'Task.tsx',
  'Subagent.tsx',
  'Terminal.tsx',
  'TestResults.tsx',
  'StackTrace.tsx',
];
const DEFINED = [
  CSS,
  ...['trace.css', 'foundation.css', 'code-block.css', '../../styles/index.css'].map((path) =>
    strip(read(path)),
  ),
].join('\n');

describe('trace-steps.css', () => {
  it('paints with DS tokens only', () => {
    expect(CSS).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/i);
  });

  it('adds no motion of its own', () => {
    expect(CSS).not.toMatch(/\b(?:transition|animation)[\w-]*:/);
    expect(CSS).not.toMatch(/(?<![\w-])\d*\.?\d+m?s\b/);
  });

  it('is imported by every step', () => {
    for (const file of STEPS) expect(read(file), file).toContain("import './trace-steps.css';");
  });

  it.each(STEPS)('%s draws only with classes a stylesheet defines', (file) => {
    const used = new Set(read(file).match(/\bcb-ai-[a-z][a-z-]*/g) ?? []);
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) expect(DEFINED, name).toMatch(new RegExp(`\\.${name}(?![\\w-])`));
  });
});
