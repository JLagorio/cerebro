import { describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { makeEntry } from '@/test/factories';
import {
  applyTemplateBody,
  templateFill,
  templateFillPrompt,
  applyTemplateFrontmatter,
  isTemplate,
  listTemplates,
  todayIso,
} from './templates';

const entry = (path: string, partial: Partial<Entry> = {}): Entry => ({
  path,
  filename: path.split('/').pop() ?? path,
  folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  project: null,
  title: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
  type: null,
  properties: {},
  relationships: {},
  outgoingLinks: [],
  snippet: '',
  createdAt: '2026-07-01T00:00:00Z',
  modifiedAt: '2026-07-01T00:00:00Z',
  parseError: null,
  ...partial,
});

const VARS = { title: 'Sprint Review', date: '2026-07-25' };

describe('templates', () => {
  it('isTemplate matches only the templates folder', () => {
    expect(isTemplate(entry('templates/meeting.md'))).toBe(true);
    expect(isTemplate(entry('templates/1on1/weekly.md'))).toBe(true);
    expect(isTemplate(entry('inbox/meeting.md'))).toBe(false);
  });

  it('listTemplates sorts by title', () => {
    const all = [
      entry('templates/retro.md', { title: 'Retro' }),
      entry('templates/meeting.md', { title: 'Meeting' }),
      entry('inbox/x.md'),
    ];
    expect(listTemplates(all).map((t) => t.title)).toEqual(['Meeting', 'Retro']);
  });

  it('applyTemplateBody substitutes placeholders', () => {
    const body = '# {{title}}\n\nDate: {{date}}\n';
    expect(applyTemplateBody(body, VARS)).toBe('# Sprint Review\n\nDate: 2026-07-25\n');
  });

  it('applyTemplateBody prepends an H1 when the template lacks one', () => {
    expect(applyTemplateBody('Just notes.\n', VARS)).toBe('# Sprint Review\n\nJust notes.\n');
  });

  it('applyTemplateFrontmatter carries type, substituted scalars, and links', () => {
    const template = entry('templates/meeting.md', {
      type: 'Meeting',
      properties: { date: '{{date}}', recurring: true },
      relationships: { facilitator: ['maya-chen'] },
    });
    expect(applyTemplateFrontmatter(template, VARS)).toEqual({
      type: 'Meeting',
      date: '2026-07-25',
      recurring: true,
      facilitator: ['[[maya-chen]]'],
    });
  });

  it('todayIso is a YYYY-MM-DD date', () => {
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

/**
 * M17.10 — a template that knows how to fill itself.
 *
 * `fill:` is a declared PROMPT, not a new artifact type. The template stays an
 * ordinary markdown file you can open and edit, which is the whole point: the
 * useful version of "AI-assisted PRD" is one the person can change. A built-in
 * generator is a black box producing someone else's idea of a PRD, and the only
 * way to disagree with it is to stop using it.
 */
describe('templateFill', () => {
  const template = (properties: Record<string, unknown>) =>
    makeEntry({
      path: 'templates/prd.md',
      folder: 'templates',
      title: 'PRD',
      properties: properties as never,
    });

  it('is empty for an ordinary template, which then behaves exactly as before', () => {
    expect(templateFill(template({}))).toBe('');
  });

  it('reads the declared instruction', () => {
    expect(templateFill(template({ fill: '  Draft it from the project.  ' }))).toBe(
      'Draft it from the project.',
    );
  });

  it('never copies itself onto the page it makes', () => {
    // Otherwise every page made from the template would look like a template
    // and re-fill itself the next time anyone opened it.
    const frontmatter = applyTemplateFrontmatter(template({ fill: 'x', status: 'draft' }), VARS);
    expect('fill' in frontmatter).toBe(false);
    expect(frontmatter.status).toBe('draft');
  });
});

describe('templateFillPrompt', () => {
  const prompt = templateFillPrompt('docs/a.md', 'A PRD', 'Draft the risks from what we know.');

  it('names the page that already exists rather than asking for a new one', () => {
    expect(prompt).toContain('docs/a.md');
    expect(prompt).toContain('Do not create a second page');
  });

  it('forbids inventing content for a section the base knows nothing about', () => {
    // A template filled with plausible fiction is worse than one left blank —
    // the blank one is obviously unfinished.
    expect(prompt).toContain('instead of inventing content');
  });

  it('carries the template author’s own words through', () => {
    expect(prompt).toContain('Draft the risks from what we know.');
  });
});
