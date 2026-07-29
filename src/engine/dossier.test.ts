import { describe, expect, it } from 'vitest';
import { buildDossier, isEmptyDossier } from './dossier';
import { listConcepts } from './okf';
import { makeEntry } from './testHelpers';

const TODAY = '2026-07-28';
const PHOENIX = 'projects/phoenix/project.md';

const project = makeEntry({
  path: PHOENIX,
  filename: 'project.md',
  type: 'Project',
  title: 'Phoenix',
});

const concept = (
  path: string,
  title: string,
  properties: Record<string, unknown> = {},
  relationships: Record<string, string[]> = {},
) =>
  makeEntry({
    path,
    filename: path.split('/').pop(),
    properties: { title, generated: { by: 'claude-code', at: '2026-07-20T09:00:00Z' }, ...properties },
    relationships: { about: ['phoenix'], ...relationships },
  });

const build = (extra: ReturnType<typeof makeEntry>[]) => {
  const entries = [project, ...extra];
  return buildDossier(PHOENIX, listConcepts(entries, TODAY), entries);
};

describe('buildDossier', () => {
  it('is empty when the base knows nothing about the entity', () => {
    expect(isEmptyDossier(build([]))).toBe(true);
  });

  it('separates live knowledge from what has been replaced', () => {
    // Ordered rather than mixed: a replaced claim shown among live ones is
    // worse than not showing it, because it reads as current.
    const dossier = build([
      concept('knowledge/a.md', 'Offline window'),
      concept('knowledge/b.md', 'Offline window', {}, { supersedes: ['a'] }),
      concept('knowledge/c.md', 'Old playbook', { lifecycle: 'deprecated' }),
    ]);
    expect(dossier.current.map((c) => c.entry.path)).toEqual(['knowledge/b.md']);
    expect(dossier.retired.map((c) => c.entry.path).sort()).toEqual([
      'knowledge/a.md',
      'knowledge/c.md',
    ]);
  });

  it('reports a disagreement once, however many ends declared it', () => {
    const dossier = build([
      concept('knowledge/a.md', 'Drain time', {}, { contradicts: ['b'] }),
      concept('knowledge/b.md', 'Drain time redux', {}, { contradicts: ['a'] }),
    ]);
    const clashes = dossier.unsettled.filter((u) => u.reason === 'contradicts');
    expect(clashes).toHaveLength(1);
    expect(clashes[0].other).not.toBeNull();
  });

  it('counts a stale concept as unsettled, but never a retired one', () => {
    const dossier = build([
      concept('knowledge/a.md', 'Sync rate', { stale_after: '2026-07-01' }),
      // Stale AND replaced: the replacement is the answer, so it is not an
      // open question.
      concept('knowledge/b.md', 'Old rate', { stale_after: '2026-07-01' }),
      concept('knowledge/c.md', 'New rate', {}, { supersedes: ['b'] }),
    ]);
    expect(dossier.unsettled.filter((u) => u.reason === 'stale').map((u) => u.concept.entry.path)).toEqual(
      ['knowledge/a.md'],
    );
  });

  it('dedupes the reading list and ranks by how often a source is cited', () => {
    // The same standup feeding three concepts is ONE thing that was read;
    // listing it three times would overstate the corpus behind the claims.
    const cite = (id: string, resource: string) => ({ id, resource, title: 'Standup' });
    const dossier = build([
      concept('knowledge/a.md', 'A', { sources: [cite('s', '/inbox/standup.md')] }),
      concept('knowledge/b.md', 'B', { sources: [cite('s', 'inbox/standup.md')] }),
      concept('knowledge/c.md', 'C', {
        sources: [cite('s', 'inbox/standup.md'), cite('t', 'sources/issues/phx-421.md')],
      }),
    ]);
    expect(dossier.readFrom.map((s) => [s.resource, s.citedBy])).toEqual([
      ['inbox/standup.md', 3],
      ['sources/issues/phx-421.md', 1],
    ]);
  });

  it('leaves a replaced concept out of the reading list', () => {
    const dossier = build([
      concept('knowledge/a.md', 'Old', { sources: [{ id: 's', resource: 'inbox/old.md' }] }),
      concept('knowledge/b.md', 'New', { sources: [{ id: 's', resource: 'inbox/new.md' }] }, {
        supersedes: ['a'],
      }),
    ]);
    expect(dossier.readFrom.map((s) => s.resource)).toEqual(['inbox/new.md']);
  });

  it('brackets when the base started and last learned about this', () => {
    const dossier = build([
      concept('knowledge/a.md', 'A', { generated: { by: 'claude-code', at: '2026-05-14T10:00:00Z' } }),
      concept('knowledge/b.md', 'B', { generated: { by: 'claude-code', at: '2026-07-26T10:00:00Z' } }),
    ]);
    expect(dossier.firstLearned).toBe('2026-05-14T10:00:00Z');
    expect(dossier.lastLearned).toBe('2026-07-26T10:00:00Z');
    // Newest first: the last thing learned is the thing most worth reading.
    expect(dossier.current.map((c) => c.entry.path)).toEqual(['knowledge/b.md', 'knowledge/a.md']);
  });
});
