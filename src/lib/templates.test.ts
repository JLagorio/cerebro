import { describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import {
  applyTemplateBody,
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
