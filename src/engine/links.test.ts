import { describe, expect, it } from 'vitest';
import { backlinksFor, outgoingFor } from './links';
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

const kickoff = entry('meetings/kickoff.md', { title: 'Kickoff' });
const spec = entry('docs/spec.md', {
  title: 'Spec',
  outgoingLinks: ['kickoff'],
  relationships: { owner: ['maya'] },
});
const maya = entry('people/maya.md', { title: 'Maya' });
const orphan = entry('docs/orphan.md');
const VAULT = [kickoff, spec, maya, orphan];

describe('outgoingFor', () => {
  it('resolves body wikilinks and relationship fields', () => {
    const links = outgoingFor(spec, VAULT);
    expect(links.map((l) => [l.entry.path, l.via])).toEqual([
      ['meetings/kickoff.md', 'body'],
      ['people/maya.md', 'owner'],
    ]);
  });

  it('drops unresolvable targets', () => {
    const broken = entry('d.md', { outgoingLinks: ['nowhere'] });
    expect(outgoingFor(broken, VAULT)).toEqual([]);
  });
});

describe('backlinksFor', () => {
  it('finds notes linking here via body or fields, labeled by how', () => {
    expect(backlinksFor(kickoff, VAULT).map((l) => [l.entry.path, l.via])).toEqual([
      ['docs/spec.md', 'body'],
    ]);
    expect(backlinksFor(maya, VAULT).map((l) => [l.entry.path, l.via])).toEqual([
      ['docs/spec.md', 'owner'],
    ]);
    expect(backlinksFor(orphan, VAULT)).toEqual([]);
  });
});
