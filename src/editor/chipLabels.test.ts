import { describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { assigneeLabel, wikilinkLabel } from './chipLabels';

/** What a link or person chip says on the page (M59.6): the chips render it,
 * and find searches it. */

const entry = (path: string, title: string): Entry => ({
  path,
  filename: path.split('/').pop() ?? path,
  folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
  project: null,
  title,
  type: null,
  properties: {},
  relationships: {},
  outgoingLinks: [],
  snippet: '',
  createdAt: '2026-07-01T00:00:00Z',
  modifiedAt: '2026-07-01T00:00:00Z',
  parseError: null,
  hash: null,
});

const ENTRIES = [entry('notes/kickoff.md', 'Project kickoff'), entry('people/ana.md', 'Ana Ruiz')];

describe('wikilinkLabel', () => {
  it('reads the alias first', () => {
    expect(wikilinkLabel({ target: 'kickoff', alias: 'the kickoff' }, ENTRIES)).toBe('the kickoff');
  });

  it('reads the resolved title', () => {
    expect(wikilinkLabel({ target: 'kickoff', alias: '' }, ENTRIES)).toBe('Project kickoff');
  });

  it('reads Title › Heading for a section link', () => {
    expect(wikilinkLabel({ target: 'kickoff#Risks', alias: '' }, ENTRIES)).toBe(
      'Project kickoff › Risks',
    );
  });

  it('reads a heading of the note it sits in for a bare section link', () => {
    expect(wikilinkLabel({ target: '#Risks', alias: '' }, ENTRIES, 'notes/kickoff.md')).toBe(
      'Project kickoff › Risks',
    );
  });

  it('reads the raw target when the link dangles', () => {
    expect(wikilinkLabel({ target: 'nowhere', alias: '' }, ENTRIES)).toBe('nowhere');
    expect(wikilinkLabel({ target: '#Risks', alias: '' }, ENTRIES)).toBe('#Risks');
  });
});

describe('assigneeLabel', () => {
  it("reads the person's title, or the target when nobody answers", () => {
    expect(assigneeLabel({ target: 'ana' }, ENTRIES)).toBe('Ana Ruiz');
    expect(assigneeLabel({ target: 'bob' }, ENTRIES)).toBe('bob');
  });
});
