import { describe, expect, it } from 'vitest';
import { TOOLS } from '@/lib/policy/tools';
import { pagePrompt, type PagePromptInput } from './pagePrompt';

const PAGE: PagePromptInput = {
  title: 'Release checklist',
  path: 'delivery/release-checklist.md',
  properties: { status: 'active', tags: ['ops', 'release'] },
  relationships: { owner: ['Jane Doe'], blocks: ['Cutover', 'Freeze'] },
  body: '\n# Release checklist\n\nShip on Thursday.\n\n',
};

describe('pagePrompt (M55.9)', () => {
  it('says what the page is, then its properties, then the page', () => {
    expect(pagePrompt(PAGE)).toBe(
      [
        'Use this page from my Cerebro notes as context.',
        '',
        'Title: Release checklist',
        'Path: delivery/release-checklist.md',
        '',
        '<properties>',
        'status: active',
        'tags:',
        '  - ops',
        '  - release',
        'owner:',
        '  - "[[Jane Doe]]"',
        'blocks:',
        '  - "[[Cutover]]"',
        '  - "[[Freeze]]"',
        '</properties>',
        '',
        '<page>',
        '# Release checklist',
        '',
        'Ship on Thursday.',
        '</page>',
      ].join('\n'),
    );
  });

  it('leaves the block out when there is nothing to put in it', () => {
    const prompt = pagePrompt({ ...PAGE, properties: {}, relationships: { owner: [] } });
    expect(prompt).not.toContain('<properties>');
    expect(prompt).toBe(
      [
        'Use this page from my Cerebro notes as context.',
        '',
        'Title: Release checklist',
        'Path: delivery/release-checklist.md',
        '',
        '<page>',
        '# Release checklist',
        '',
        'Ship on Thursday.',
        '</page>',
      ].join('\n'),
    );
  });

  it('keeps the block for relationships alone', () => {
    const prompt = pagePrompt({ ...PAGE, properties: {} });
    expect(prompt).toContain('<properties>\nowner:\n  - "[[Jane Doe]]"');
  });

  it('says an empty page is empty', () => {
    expect(pagePrompt({ ...PAGE, body: '  \n\n' })).toContain(
      '<page>\n(This page is empty.)\n</page>',
    );
  });

  it('carries the vault-relative path and never an absolute one', () => {
    const prompt = pagePrompt(PAGE);
    expect(prompt).toContain('Path: delivery/release-checklist.md');
    expect(prompt).not.toMatch(/\/Users\/|\/home\/|^\/|\s\//m);
  });

  it('names no Cerebro tool on a neutral page', () => {
    const prompt = pagePrompt(PAGE);
    const names = TOOLS.tools.map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(prompt).not.toContain(name);
  });

  it('is deterministic', () => {
    expect(pagePrompt(PAGE)).toBe(pagePrompt(structuredClone(PAGE)));
  });
});
