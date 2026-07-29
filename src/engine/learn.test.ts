import { describe, expect, it } from 'vitest';
import { isLearnable, learnQueue } from './learn';
import { listConcepts } from './okf';
import { makeEntry } from './testHelpers';

const TODAY = '2026-07-28';

const note = (path: string, patch: Partial<ReturnType<typeof makeEntry>> = {}) =>
  makeEntry({
    path,
    filename: path.split('/').pop(),
    snippet: 'something worth reading',
    modifiedAt: '2026-07-28T09:00:00Z',
    ...patch,
  });

/** A concept citing `resource`, stamped at `at`. */
const cites = (path: string, resource: string, at = '2026-07-28T10:00:00Z') =>
  makeEntry({
    path,
    filename: path.split('/').pop(),
    properties: {
      sources: [{ id: 's', resource }],
      generated: { by: 'claude-code', at },
    },
  });

const NO_ATTEMPTS = { filed: [], attempts: {} };

describe('isLearnable', () => {
  it('never points the distiller at the bundle itself', () => {
    // Knowledge distilled from knowledge has no fixed point: every pass would
    // cite the one before it.
    expect(isLearnable(note('knowledge/systems/a.md'))).toBe(false);
    expect(isLearnable(note('inbox/a.md'))).toBe(true);
  });

  it('skips schema and unreadable notes', () => {
    expect(isLearnable(note('types/spec.md'))).toBe(false);
    expect(isLearnable(note('inbox/a.md', { parseError: 'bad yaml' }))).toBe(false);
    // An empty note produces an invented concept, not an honest one.
    expect(isLearnable(note('inbox/a.md', { snippet: '   ' }))).toBe(false);
  });
});

describe('learnQueue', () => {
  it('is empty when nothing has been filed and nothing has moved', () => {
    const entries = [note('inbox/a.md')];
    expect(learnQueue(entries, listConcepts([], TODAY), NO_ATTEMPTS)).toEqual([]);
  });

  it('queues a filed capture the base has never read', () => {
    const entries = [note('inbox/a.md'), note('inbox/b.md')];
    const jobs = learnQueue(entries, listConcepts([], TODAY), {
      filed: ['inbox/a.md'],
      attempts: {},
    });
    expect(jobs.map((j) => [j.path, j.reason])).toEqual([['inbox/a.md', 'filed']]);
  });

  it('does not re-read a filed capture the base is already current on', () => {
    const entries = [note('inbox/a.md')];
    const concepts = listConcepts([cites('knowledge/a.md', 'inbox/a.md')], TODAY);
    expect(learnQueue(entries, concepts, { filed: ['inbox/a.md'], attempts: {} })).toEqual([]);
  });

  it('queues an edited note WITHOUT anyone reporting the edit', () => {
    // The whole point: no close event, no dirty flag, no subscription. The
    // note's mtime moved past the stamp on the concept that cites it.
    const entries = [note('projects/p/prd.md', { modifiedAt: '2026-07-29T08:00:00Z' })];
    const concepts = listConcepts([cites('knowledge/a.md', 'projects/p/prd.md')], TODAY);
    const jobs = learnQueue(entries, concepts, NO_ATTEMPTS);
    expect(jobs.map((j) => [j.path, j.reason])).toEqual([['projects/p/prd.md', 'behind']]);
  });

  it('stops retrying a version it has already attempted', () => {
    // A distillation that found nothing durable writes no concept, so the note
    // stays exactly as outstanding as before. Without the attempt record the
    // runner picks it up again on every tick, forever.
    const entries = [note('inbox/a.md')];
    const attempts = { 'inbox/a.md': '2026-07-28T09:00:00Z' };
    expect(learnQueue(entries, listConcepts([], TODAY), { filed: ['inbox/a.md'], attempts })).toEqual(
      [],
    );
    // Edit it again and it comes back — the attempt was against one version.
    const edited = [note('inbox/a.md', { modifiedAt: '2026-07-30T09:00:00Z' })];
    expect(
      learnQueue(edited, listConcepts([], TODAY), { filed: ['inbox/a.md'], attempts }),
    ).toHaveLength(1);
  });

  it('answers filing before it catches up on edits', () => {
    const entries = [
      note('projects/p/prd.md', { modifiedAt: '2026-07-30T08:00:00Z' }),
      note('inbox/a.md'),
    ];
    const concepts = listConcepts([cites('knowledge/a.md', 'projects/p/prd.md')], TODAY);
    const jobs = learnQueue(entries, concepts, { filed: ['inbox/a.md'], attempts: {} });
    expect(jobs.map((j) => j.reason)).toEqual(['filed', 'behind']);
  });
});
