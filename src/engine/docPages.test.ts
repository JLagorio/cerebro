import { describe, expect, it } from 'vitest';
import { docFolderPathFor, docPagesFor, folderNote, isDocFolder } from './docPages';
import type { Entry } from './types';

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

const VAULT = [
  entry('notes/josef-1-1/josef-1-1.md', { createdAt: '2026-07-01T00:00:00Z' }),
  entry('notes/josef-1-1/agenda.md', { createdAt: '2026-07-03T00:00:00Z' }),
  entry('notes/josef-1-1/history.md', { createdAt: '2026-07-02T00:00:00Z' }),
  entry('notes/loose.md'),
  entry('projects/alpha/project.md'),
  entry('projects/alpha/spec.md'),
];

describe('docPages (folder-note pattern)', () => {
  it('folderNote finds the note matching its folder name', () => {
    expect(folderNote('notes/josef-1-1', VAULT)?.path).toBe('notes/josef-1-1/josef-1-1.md');
    expect(folderNote('notes', VAULT)).toBeNull();
    expect(folderNote('', VAULT)).toBeNull();
  });

  it('docPagesFor returns pages in tab order: main first, then by creation', () => {
    const pages = docPagesFor(VAULT[1], VAULT)!; // asked from a non-main page
    expect(pages.folder).toBe('notes/josef-1-1');
    expect(pages.main.path).toBe('notes/josef-1-1/josef-1-1.md');
    expect(pages.pages.map((p) => p.path)).toEqual([
      'notes/josef-1-1/josef-1-1.md',
      'notes/josef-1-1/history.md',
      'notes/josef-1-1/agenda.md',
    ]);
  });

  it('plain files and project folders are not multi-page docs', () => {
    expect(docPagesFor(VAULT[3], VAULT)).toBeNull();
    expect(docPagesFor(VAULT[5], VAULT)).toBeNull(); // alpha/ holds project.md, not alpha.md
    expect(isDocFolder('projects/alpha', VAULT)).toBe(false);
    expect(isDocFolder('notes/josef-1-1', VAULT)).toBe(true);
  });

  it('docFolderPathFor names the folder a doc would grow into', () => {
    expect(docFolderPathFor(entry('notes/loose.md'))).toBe('notes/loose');
    expect(docFolderPathFor(entry('root.md'))).toBe('root');
  });
});
