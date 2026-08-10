import { describe, expect, it } from 'vitest';
import { groupDocsByRoot, isMarkdownPath, parentPath, viewerKindFor } from './roots';
import type { IndexedDoc } from './roots';

const doc = (root: string, path: string, isReadme = false): IndexedDoc => ({
  root,
  path,
  title: path,
  snippet: '',
  modifiedAt: '2026-08-09T00:00:00Z',
  depth: path.split('/').length - 1,
  isReadme,
});

describe('isMarkdownPath', () => {
  it('accepts .md and .markdown regardless of case', () => {
    expect(isMarkdownPath('README.md')).toBe(true);
    expect(isMarkdownPath('docs/Guide.MARKDOWN')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isMarkdownPath('src/main.rs')).toBe(false);
    expect(isMarkdownPath('mdfile')).toBe(false);
  });
});

describe('viewerKindFor', () => {
  it('routes markdown to the doc viewer', () => {
    expect(viewerKindFor('README.md')).toBe('doc');
  });

  it('routes anything else to the code viewer', () => {
    expect(viewerKindFor('src/main.rs')).toBe('code');
    expect(viewerKindFor('Dockerfile.dev')).toBe('code');
  });
});

describe('parentPath', () => {
  it('drops the last segment', () => {
    expect(parentPath('docs/guide/setup.md')).toBe('docs/guide');
  });

  it('returns the root for a top-level path', () => {
    expect(parentPath('README.md')).toBe('');
  });
});

describe('groupDocsByRoot', () => {
  it('preserves the mounted-root order, not alphabetical order', () => {
    const docs = [doc('beta', 'b.md'), doc('alpha', 'a.md')];
    const groups = groupDocsByRoot(docs, ['alpha', 'beta']);
    expect(groups.map((g) => g.root)).toEqual(['alpha', 'beta']);
  });

  it('omits roots with no documents', () => {
    const groups = groupDocsByRoot([doc('alpha', 'a.md')], ['alpha', 'beta']);
    expect(groups).toHaveLength(1);
  });

  it('keeps every document belonging to a root together', () => {
    const docs = [doc('alpha', 'a.md'), doc('beta', 'b.md'), doc('alpha', 'c.md')];
    const groups = groupDocsByRoot(docs, ['alpha', 'beta']);
    expect(groups[0].docs.map((d) => d.path)).toEqual(['a.md', 'c.md']);
    expect(groups[1].docs.map((d) => d.path)).toEqual(['b.md']);
  });
});
