import { afterEach, describe, expect, it } from 'vitest';
import STALENESS_CASES from '../../shared/policy/staleness.v1.json';
import {
  commitOf,
  conceptEdges,
  conceptsAbout,
  conceptsFrom,
  footnoteRefs,
  nearDuplicates,
  isConcept,
  canonicalKnowledgePath,
  humanReviewed,
  isKnowledgePath,
  knowledgeOf,
  staleAfterOf,
  staleFrom,
  isStale,
  lastVerifiedAt,
  lifecycleOf,
  listConcepts,
  NO_QUARANTINE,
  supersessionKey,
  listSections,
  listSubjects,
  localDayOf,
  needsReview,
  queueReason,
  reviewQueue,
  parseAbout,
  parseActor,
  parseGenerated,
  parseLog,
  parseSources,
  parseVerified,
  readableHorizon,
  readThread,
  recentlyLearned,
  recheckLine,
  relatedConcepts,
  resolveBundleLink,
  reviewReasons,
  sectionOf,
  sectionOfPath,
  sourceCount,
  toConcept,
  updatedAt,
  reviewStatus,
  reviewedBy,
  verifyPatch,
} from './okf';
import { makeEntry } from './testHelpers';
import type { Entry } from './types';

const TODAY = '2026-07-28';

const concept = (properties: Record<string, unknown>, path = 'knowledge/metrics/revenue.md') =>
  makeEntry({ path, filename: path.split('/').pop(), type: 'Metric', properties });

describe('bundle boundary', () => {
  it('recognises the knowledge bundle by path', () => {
    expect(isKnowledgePath('knowledge/metrics/revenue.md')).toBe(true);
    expect(isKnowledgePath('knowledge')).toBe(true);
    // Must not match a sibling directory that merely shares the prefix.
    expect(isKnowledgePath('knowledge-archive/x.md')).toBe(false);
    expect(isKnowledgePath('records/risks/r.md')).toBe(false);
    // M49.4 (K17): the resolved path — the same table knowledge.rs asserts.
    const table: [string, string | null][] = [
      ['./knowledge/x.md', 'knowledge/x.md'],
      ['Knowledge/x.md', 'knowledge/x.md'],
      ['KNOWLEDGE/log.md', 'knowledge/log.md'],
      ['knowledge//a/./b.md', 'knowledge/a/b.md'],
      ['records/../knowledge/x.md', 'knowledge/x.md'],
      ['knowledge/../knowledge/x.md', 'knowledge/x.md'],
      ['knowledge/../records/x.md', null],
      ['../knowledge/x.md', null],
      ['/knowledge/x.md', null],
      ['knowledge-archive/x.md', null],
      ['', null],
    ];
    for (const [raw, canonical] of table) {
      expect(canonicalKnowledgePath(raw), raw).toBe(canonical);
      expect(isKnowledgePath(raw), raw).toBe(canonical !== null);
    }
  });

  it('treats OKF reserved files as structure, not concepts', () => {
    expect(isConcept(makeEntry({ path: 'knowledge/index.md', filename: 'index.md' }))).toBe(false);
    expect(isConcept(makeEntry({ path: 'knowledge/log.md', filename: 'log.md' }))).toBe(false);
    expect(isConcept(makeEntry({ path: 'knowledge/a.md', filename: 'a.md' }))).toBe(true);
    expect(isConcept(makeEntry({ path: 'records/a.md', filename: 'a.md' }))).toBe(false);
  });
});

describe('parseActor', () => {
  it('classifies the three actor shapes', () => {
    expect(parseActor('human:ahormati')).toEqual({
      kind: 'human',
      label: 'ahormati',
      raw: 'human:ahormati',
    });
    expect(parseActor('process:finance-nightly')?.kind).toBe('process');
    expect(parseActor('reference_agent/gemini-2.5-pro')?.kind).toBe('agent');
  });

  it('never guesses an unrecognized shape into a human', () => {
    // Trust classification keys off the `human:` prefix (§7) — inferring it
    // would silently promote machine output to human-reviewed.
    expect(parseActor('ahormati')?.kind).toBe('agent');
    expect(parseActor('')).toBeNull();
    expect(parseActor(42)).toBeNull();
  });
});

describe('review status and who did it', () => {
  it('reads absent verification as unreviewed, with nobody named', () => {
    expect(reviewStatus(concept({}))).toBe('unreviewed');
    expect(reviewedBy(concept({}))).toBeNull();
  });

  it('keeps the actor beside the status instead of ranking one above it', () => {
    // The old three-rung tier said "machine-confirmed" and "human-reviewed"
    // on one ladder. M27.5c splits them: BOTH are a current review, and who
    // did it is a separate fact the queue reads for itself.
    const machine = concept({ verified: [{ by: 'process:nightly', at: '2026-07-01T00:00:00Z' }] });
    expect(reviewStatus(machine)).toBe('current');
    expect(reviewedBy(machine)).toBe('agent');

    const human = concept({
      verified: [
        { by: 'process:nightly', at: '2026-07-01T00:00:00Z' },
        { by: 'human:josef', at: '2026-07-20T00:00:00Z' },
      ],
    });
    expect(reviewStatus(human)).toBe('current');
    expect(reviewedBy(human)).toBe('human');
  });

  it('says a review that predates the revision out loud (M23 r5)', () => {
    // The projection rendered a notice instead of a stamp. "Somebody looked,
    // at something else" is its own answer — collapsing it into `unreviewed`
    // throws away the fact that a review happened at all.
    const predating = concept({
      verified: 'verified at r2; current is r3 — attestation predates revision',
    });
    expect(reviewStatus(predating)).toBe('predates_current');
    expect(reviewedBy(predating)).toBeNull();
  });

  it('treats a bare verified mapping as a one-element list', () => {
    // §5.2 MUST — producers may omit the list dash for a single verifier.
    const bare = concept({ verified: { by: 'human:josef', at: '2026-07-20T00:00:00Z' } });
    expect(parseVerified(bare)).toHaveLength(1);
    expect(reviewStatus(bare)).toBe('current');
    expect(reviewedBy(bare)).toBe('human');
  });

  it('drops a stamp with no actor rather than showing an empty author', () => {
    expect(parseVerified(concept({ verified: [{ at: '2026-07-20' }] }))).toEqual([]);
    expect(parseGenerated(concept({ generated: { at: '2026-07-20' } }))).toBeNull();
  });

  it('reports the latest verification instant', () => {
    const e = concept({
      verified: [
        { by: 'human:josef', at: '2026-07-02T00:00:00Z' },
        { by: 'process:nightly', at: '2026-07-26T00:00:00Z' },
      ],
    });
    expect(lastVerifiedAt(e)).toBe('2026-07-26T00:00:00Z');
    expect(lastVerifiedAt(concept({}))).toBeNull();
  });
});

describe('provenance', () => {
  it('parses sources with their credibility signals', () => {
    const e = concept({
      usage_window: { from: '2026-06-01', to: '2026-06-30' },
      sources: [
        {
          id: 'ga4-schema',
          resource: 'https://example.com/schema',
          title: 'GA4 export schema',
          author: 'team:ga4-docs',
          usage_count: 5000,
          last_modified: '2026-05-30',
        },
      ],
    });
    const [source] = parseSources(e);
    expect(source.id).toBe('ga4-schema');
    expect(source.usageCount).toBe(5000);
    expect(source.author?.kind).toBe('agent');
    // usage_window is written once beside `sources` and frames every count.
    expect(source.usageWindow).toEqual({ from: '2026-06-01', to: '2026-06-30' });
  });

  it('lets an entry override the shared usage window', () => {
    const e = concept({
      usage_window: { from: '2026-06-01', to: '2026-06-30' },
      sources: [{ resource: 'x', usage_window: { from: '2026-01-01', to: '2026-01-31' } }],
    });
    expect(parseSources(e)[0].usageWindow).toEqual({ from: '2026-01-01', to: '2026-01-31' });
  });

  it('skips entries with no resource, which name nothing', () => {
    expect(parseSources(concept({ sources: [{ id: 'x' }, { resource: 'y' }] }))).toHaveLength(1);
  });

  it('tolerates a missing or malformed sources list', () => {
    expect(parseSources(concept({}))).toEqual([]);
    expect(parseSources(concept({ sources: 'nope' }))).toEqual([]);
  });

  // M52.5 — a count column. `parseSources` reads both as [], and 0 for a list
  // nobody wrote would say it was measured.
  it('counts sources, and a list nobody wrote is no count at all', () => {
    expect(sourceCount(concept({ sources: [{ resource: 'a' }, { resource: 'b' }] }))).toBe(2);
    expect(sourceCount(concept({ sources: [] }))).toBe(0);
    // An entry that names nothing is no source, as `parseSources` says.
    expect(sourceCount(concept({ sources: [{ id: 'x' }] }))).toBe(0);
    expect(sourceCount(concept({}))).toBeNull();
    expect(sourceCount(concept({ sources: null }))).toBeNull();
    expect(sourceCount(concept({ sources: 'nope' }))).toBeNull();
  });
});

describe('updatedAt (M52.5)', () => {
  const at = (properties: Record<string, unknown>, modifiedAt = '2026-07-01T00:00:00Z') =>
    updatedAt(
      toConcept(
        makeEntry({
          path: 'knowledge/a.md',
          filename: 'a.md',
          type: 'Metric',
          properties,
          modifiedAt,
        }),
        TODAY,
      ),
    );

  it('is the newest of the writing, the reviews and the file', () => {
    expect(
      at({
        generated: { by: 'claude-code', at: '2026-07-20T10:00:00Z' },
        verified: [
          { by: 'human:josef', at: '2026-07-24T09:00:00Z' },
          { by: 'human:tom', at: '2026-07-22T09:00:00Z' },
        ],
      }),
    ).toBe('2026-07-24T09:00:00Z');
    // An edit that wrote no stamp is newer than every stamp.
    expect(
      at({ generated: { by: 'claude-code', at: '2026-07-20T10:00:00Z' } }, '2026-07-27T08:00:00Z'),
    ).toBe('2026-07-27T08:00:00Z');
  });

  it('skips a stamp whose instant cannot be read, and falls back on the file', () => {
    expect(at({ generated: { by: 'claude-code', at: 'last tuesday' } })).toBe(
      '2026-07-01T00:00:00Z',
    );
    expect(at({})).toBe('2026-07-01T00:00:00Z');
  });
});

describe('lifecycle and staleness', () => {
  it('defaults to stable and reads ours from `lifecycle`, not `status`', () => {
    expect(lifecycleOf(concept({}))).toBe('stable');
    expect(lifecycleOf(concept({ lifecycle: 'draft' }))).toBe('draft');
    expect(lifecycleOf(concept({ lifecycle: 'deprecated' }))).toBe('deprecated');
    // `status` is work-item status in cerebro and must not drive lifecycle.
    expect(lifecycleOf(concept({ status: 'deprecated' }))).toBe('stable');
    expect(lifecycleOf(concept({ lifecycle: 'nonsense' }))).toBe('stable');
  });

  it('is stale on and after stale_after', () => {
    const e = concept({ stale_after: '2026-07-28' });
    expect(isStale(e, '2026-07-27')).toBe(false);
    expect(isStale(e, '2026-07-28')).toBe(true);
    expect(isStale(e, '2026-07-29')).toBe(true);
    expect(isStale(concept({}), '2026-07-28')).toBe(false);
  });
});

describe('toConcept', () => {
  it('builds the view-model and tolerates an unknown type', () => {
    const e = concept({
      title: 'Revenue',
      description: 'Recognised revenue, all channels.',
      resource: 'https://example.com/revenue',
      tags: ['finance', 'revenue'],
      generated: { by: 'claude-code/2.0', at: '2026-07-20T00:00:00Z' },
    });
    const c = toConcept(e, TODAY);
    expect(c.id).toBe('knowledge/metrics/revenue');
    expect(c.title).toBe('Revenue');
    expect(c.conceptType).toBe('Metric');
    expect(c.tags).toEqual(['finance', 'revenue']);
    expect(c.generated?.by.label).toBe('claude-code/2.0');
    expect(c.review).toBe('unreviewed');
    expect(c.reviewedBy).toBeNull();
  });

  it('falls back to the entry title and a generic type', () => {
    const bare = makeEntry({ path: 'knowledge/a.md', filename: 'a.md', title: 'A', type: null });
    const c = toConcept(bare, TODAY);
    expect(c.title).toBe('A');
    expect(c.conceptType).toBe('Concept');
  });
});

describe('review queue', () => {
  it('flags unverified, stale, and deprecated concepts', () => {
    expect(reviewReasons(toConcept(concept({}), TODAY))).toEqual(['unverified']);

    const machine = toConcept(
      concept({ verified: [{ by: 'process:n', at: '2026-01-01' }], stale_after: '2026-01-01' }),
      TODAY,
    );
    expect(reviewReasons(machine)).toEqual(['unverified', 'stale']);

    const reviewed = toConcept(
      concept({ verified: [{ by: 'human:josef', at: '2026-07-01' }] }),
      TODAY,
    );
    expect(needsReview(reviewed)).toBe(false);
  });

  it('lists concepts in the bundle, skipping reserved files', () => {
    const entries = [
      makeEntry({ path: 'knowledge/index.md', filename: 'index.md' }),
      concept({}, 'knowledge/b.md'),
      concept({}, 'knowledge/a.md'),
      makeEntry({ path: 'records/r.md', filename: 'r.md' }),
    ];
    expect(listConcepts(entries, TODAY).map((c) => c.id)).toEqual(['knowledge/a', 'knowledge/b']);
  });
});

describe('recentlyLearned', () => {
  // The window is a CALENDAR window, not a rolling 14×86400s (M26.3e). It
  // takes the same `today` string listConcepts does, so a caller cannot hold
  // two disagreeing opinions about what day it is, and a test can pin it.
  const learned = (at: string, path: string, extra: Record<string, unknown> = {}) =>
    concept({ generated: { by: 'claude-code', at }, ...extra }, path);

  const paths = (entries: ReturnType<typeof concept>[], today = TODAY, opts = {}) =>
    recentlyLearned(listConcepts(entries, today), today, opts).map((c) => c.entry.path);

  it('offers what was written inside the window and nothing older', () => {
    const entries = [
      learned('2026-07-27T09:00:00Z', 'knowledge/yesterday.md'),
      learned('2026-06-01T09:00:00Z', 'knowledge/last-month.md'),
    ];
    expect(paths(entries)).toEqual(['knowledge/yesterday.md']);
  });

  it('counts the boundary day in and the day before it out', () => {
    // 14 days back from 2026-07-28 is 2026-07-14. That day is IN — an
    // exclusive edge would make the window silently 13 days long.
    const entries = [
      learned('2026-07-14T23:59:00Z', 'knowledge/edge-in.md'),
      learned('2026-07-13T23:59:00Z', 'knowledge/edge-out.md'),
    ];
    expect(paths(entries)).toEqual(['knowledge/edge-in.md']);
  });

  it('does not slide with the hour of day', () => {
    // The old implementation subtracted 14×86400s from the instant of the
    // call, so a concept stamped early on the boundary day was in at 09:00
    // and out by lunchtime. Same day in, same answer.
    const entries = [learned('2026-07-14T00:01:00Z', 'knowledge/early.md')];
    expect(paths(entries)).toEqual(['knowledge/early.md']);
  });

  it('never volunteers something a human already confirmed', () => {
    const entries = [
      learned('2026-07-27T09:00:00Z', 'knowledge/unverified.md'),
      learned('2026-07-27T09:00:00Z', 'knowledge/reviewed.md', {
        verified: [{ by: 'human:josef', at: '2026-07-27T10:00:00Z' }],
      }),
    ];
    expect(paths(entries)).toEqual(['knowledge/unverified.md']);
  });

  it('never volunteers a claim something newer has replaced (M8.7)', () => {
    // Supersession is declared by the REPLACEMENT and arrives bracket-stripped
    // in `relationships`, so the retired concept still looks recent and
    // unverified on its own frontmatter. That is exactly why it has to be
    // filtered here rather than upstream.
    const entries = [
      learned('2026-07-20T09:00:00Z', 'knowledge/old.md'),
      makeEntry({
        path: 'knowledge/new.md',
        filename: 'new.md',
        type: 'Metric',
        properties: { generated: { by: 'claude-code', at: '2026-07-27T09:00:00Z' } },
        relationships: { supersedes: ['old'] },
      }),
    ];
    expect(paths(entries)).toEqual(['knowledge/new.md']);
  });

  it('skips a concept with no generated stamp rather than guessing one', () => {
    expect(paths([concept({}, 'knowledge/unstamped.md')])).toEqual([]);
  });

  it('skips an unparseable stamp instead of comparing it as a string', () => {
    // 'last tuesday' sorts above any ISO date, so an unguarded string compare
    // would put junk at the top of the one surface Home volunteers.
    expect(paths([learned('last tuesday', 'knowledge/junk.md')])).toEqual([]);
  });

  it('shows the newest first and never more than three', () => {
    const entries = ['22', '25', '20', '27', '24'].map((d) =>
      learned(`2026-07-${d}T09:00:00Z`, `knowledge/d${d}.md`),
    );
    expect(paths(entries)).toEqual(['knowledge/d27.md', 'knowledge/d25.md', 'knowledge/d24.md']);
  });

  it('lets the caller widen the window and the slot count', () => {
    const entries = [
      learned('2026-07-27T09:00:00Z', 'knowledge/a.md'),
      learned('2026-06-01T09:00:00Z', 'knowledge/b.md'),
    ];
    expect(paths(entries, TODAY, { days: 90, limit: 1 })).toEqual(['knowledge/a.md']);
    expect(paths(entries, TODAY, { days: 90, limit: 5 })).toEqual([
      'knowledge/a.md',
      'knowledge/b.md',
    ]);
  });
});

describe('verifyPatch', () => {
  it('appends rather than overwriting existing verification', () => {
    const e = concept({ verified: [{ by: 'process:nightly', at: '2026-07-01T00:00:00Z' }] });
    const patch = verifyPatch(e, 'human:josef', '2026-07-28T10:00:00Z');
    expect(patch.verified).toEqual([
      { by: 'process:nightly', at: '2026-07-01T00:00:00Z' },
      { by: 'human:josef', at: '2026-07-28T10:00:00Z' },
    ]);
  });

  it('promotes a bare mapping to a list when appending', () => {
    const e = concept({ verified: { by: 'process:nightly', at: '2026-07-01T00:00:00Z' } });
    expect(verifyPatch(e, 'human:josef', '2026-07-28T10:00:00Z').verified).toHaveLength(2);
  });

  it('starts a list when nothing has verified the concept yet', () => {
    expect(verifyPatch(concept({}), 'human:josef', '2026-07-28T10:00:00Z').verified).toEqual([
      { by: 'human:josef', at: '2026-07-28T10:00:00Z' },
    ]);
  });
});

describe('entity anchors', () => {
  // Wikilink-valued frontmatter lands in `relationships`, plain strings in
  // `properties` — parseAbout has to read a concept written either way.
  const anchored = (relationships: Record<string, string[]>, properties = {}) =>
    makeEntry({
      path: 'knowledge/systems/x.md',
      filename: 'x.md',
      type: 'Reference',
      relationships,
      properties,
    });

  it('reads wikilink anchors out of relationships', () => {
    expect(parseAbout(anchored({ about: ['phoenix', 'risk-rollback'] }))).toEqual([
      'phoenix',
      'risk-rollback',
    ]);
  });

  it('accepts a bare string anchor, which names its subject imprecisely but does name it', () => {
    expect(parseAbout(anchored({}, { about: 'phoenix' }))).toEqual(['phoenix']);
    expect(parseAbout(anchored({}, { about: ['a', ' b '] }))).toEqual(['a', 'b']);
  });

  it('treats an absent anchor as empty, not as an error', () => {
    expect(parseAbout(anchored({}))).toEqual([]);
    expect(parseAbout(anchored({}, { about: null }))).toEqual([]);
  });

  it('reads the section from the bundle sub-directory, top level only', () => {
    expect(sectionOf(makeEntry({ path: 'knowledge/metrics/a.md' }))).toBe('metrics');
    expect(sectionOf(makeEntry({ path: 'knowledge/a/b/c.md' }))).toBe('a');
    expect(sectionOf(makeEntry({ path: 'knowledge/a.md' }))).toBe('');
    // The same rule from a bare path — what a `doc` selection carries (M52.3).
    expect(sectionOfPath('knowledge/metrics/a.md')).toBe('metrics');
    expect(sectionOfPath('knowledge/a.md')).toBe('');
  });

  it('counts sections and sorts root-level leftovers last', () => {
    const concepts = [
      toConcept(concept({}, 'knowledge/systems/a.md'), TODAY),
      toConcept(concept({}, 'knowledge/metrics/b.md'), TODAY),
      toConcept(concept({}, 'knowledge/metrics/c.md'), TODAY),
      toConcept(concept({}, 'knowledge/loose.md'), TODAY),
    ];
    expect(listSections(concepts).map((s) => [s.label, s.count])).toEqual([
      ['Metrics', 2],
      ['Systems', 1],
      ['Ungrouped', 1],
    ]);
  });
});

describe('subjects', () => {
  const project = makeEntry({
    path: 'projects/phoenix/project.md',
    filename: 'project.md',
    folder: 'projects/phoenix',
    title: 'Phoenix warehouse rollout',
    type: 'Project',
  });

  const about = (path: string, targets: string[]) =>
    makeEntry({
      path,
      filename: path.split('/').pop(),
      type: 'Reference',
      relationships: { about: targets },
    });

  it('groups concepts by the entity they resolve to', () => {
    const entries = [
      project,
      about('knowledge/a.md', ['phoenix']),
      about('knowledge/b.md', ['phoenix']),
    ];
    const subjects = listSubjects(listConcepts(entries, TODAY), entries);
    expect(subjects).toHaveLength(1);
    expect(subjects[0].label).toBe('Phoenix warehouse rollout');
    expect(subjects[0].concepts).toHaveLength(2);
  });

  it('lists a concept under every entity it is about, not just the first', () => {
    const entries = [project, about('knowledge/a.md', ['phoenix', 'nobody'])];
    const subjects = listSubjects(listConcepts(entries, TODAY), entries);
    expect(subjects.map((s) => s.concepts.length)).toEqual([1, 1]);
  });

  it('keeps a dangling anchor rather than dropping it — the entity may not exist yet', () => {
    const entries = [about('knowledge/a.md', ['not-written-yet'])];
    const [subject] = listSubjects(listConcepts(entries, TODAY), entries);
    expect(subject.entry).toBeNull();
    expect(subject.label).toBe('not-written-yet');
  });

  it('names a thread the way its own source names it (M33a.3 / D8)', () => {
    // The anchor resolves INTO the bundle. `Entry.title` is the body H1 else
    // the humanized stem, and frontmatter `title:` is ignored for entries by
    // design — so this concept's entry is called `Rq 84b kestrel` while the
    // agent that wrote it called it `RQ-84B KESTREL program`. The nav showed
    // the humanized stem, a name nothing in the vault had ever written.
    const program = makeEntry({
      path: 'knowledge/programs/rq-84b-kestrel.md',
      filename: 'rq-84b-kestrel.md',
      folder: 'knowledge/programs',
      type: 'Reference',
      title: 'Rq 84b kestrel',
      properties: { title: 'RQ-84B KESTREL program' },
    });
    const entries = [program, about('knowledge/risks/thermal.md', ['rq-84b-kestrel'])];
    const subjects = listSubjects(listConcepts(entries, TODAY), entries);
    expect(subjects.map((s) => s.label)).toEqual(['RQ-84B KESTREL program']);
  });

  it('still falls back to the entry title for an anchor outside the bundle', () => {
    const entries = [project, about('knowledge/a.md', ['phoenix'])];
    const [subject] = listSubjects(listConcepts(entries, TODAY), entries);
    expect(subject.label).toBe('Phoenix warehouse rollout');
  });

  it('sorts threads by weight, breaking ties on the label (M33a.3 / D8)', () => {
    // Alphabetical put the one real thread under a singleton whose label
    // happened to sort earlier — the failure the design doc measured, with
    // nineteen singletons instead of two.
    const entries = [
      project,
      about('knowledge/alpha.md', ['aardvark']),
      about('knowledge/beta.md', ['barnacle']),
      ...Array.from({ length: 13 }, (_, i) => about(`knowledge/p${i}.md`, ['phoenix'])),
    ];
    const subjects = listSubjects(listConcepts(entries, TODAY), entries);
    expect(subjects.map((s) => [s.label, s.concepts.length])).toEqual([
      ['Phoenix warehouse rollout', 13],
      ['aardvark', 1],
      ['barnacle', 1],
    ]);
  });

  it('answers what a project page asks: concepts anchored to this path', () => {
    const entries = [
      project,
      about('knowledge/a.md', ['phoenix']),
      about('knowledge/b.md', ['other']),
    ];
    const found = conceptsAbout(
      'projects/phoenix/project.md',
      listConcepts(entries, TODAY),
      entries,
    );
    expect(found.map((c) => c.entry.path)).toEqual(['knowledge/a.md']);
  });
});

describe('the review queue, in the order it is worked (M51.2)', () => {
  const at = (properties: Record<string, unknown>, path: string) =>
    toConcept(concept(properties, path), TODAY);
  const human = { verified: [{ by: 'human:josef', at: '2026-07-01' }] };
  const agent = { verified: [{ by: 'process:n', at: '2026-07-01' }] };

  it('says why each concept is queued, one reason per row', () => {
    expect(queueReason(at({}, 'knowledge/a.md'))).toBe('new');
    expect(queueReason(at({ ...agent, stale_after: '2026-01-01' }, 'knowledge/a.md'))).toBe(
      'stale',
    );
    expect(queueReason(at({ ...agent, lifecycle: 'deprecated' }, 'knowledge/a.md'))).toBe(
      'deprecated',
    );
    // M52.5 — never reviewed leads, as its page leads with "Unreviewed": the
    // recheck or retirement it also owes is its reason's sentence.
    expect(queueReason(at({ stale_after: '2026-01-01' }, 'knowledge/a.md'))).toBe('new');
    expect(queueReason(at({ lifecycle: 'deprecated' }, 'knowledge/a.md'))).toBe('new');
    // Retired and already seen by a person: nothing a reviewer could do would
    // clear it, so it is not theirs to clear.
    expect(queueReason(at({ ...human, lifecycle: 'deprecated' }, 'knowledge/a.md'))).toBeNull();
    expect(
      queueReason(at({ verified: [{ by: 'process:n', at: '2026-07-01' }] }, 'knowledge/a.md')),
    ).toBe('agent-only');
    expect(queueReason(at({ verified: 'verified at r3; current is r5' }, 'knowledge/a.md'))).toBe(
      'changed',
    );
    // Membership is needsReview's — a concept a person reviewed is not queued.
    expect(queueReason(at(human, 'knowledge/a.md'))).toBeNull();
  });

  // M52.3 — Verify was the only thing a stale concept's page offered, and it
  // could not clear the row: the Review count could never reach zero.
  it('lets a person who read a concept once it was due clear its recheck row', () => {
    const due = { stale_after: '2026-07-26' };
    const verifiedOn = (day: string) =>
      at({ ...due, verified: [{ by: 'human:josef', at: `${day}T09:00:00Z` }] }, 'knowledge/a.md');
    // Read on or after the horizon: out of the queue, still stale on its page.
    const after = verifiedOn('2026-07-28');
    expect(reviewReasons(after)).toEqual([]);
    expect(queueReason(after)).toBeNull();
    expect(after.stale).toBe(true);
    expect(reviewReasons(verifiedOn('2026-07-26'))).toEqual([]);
    // Read BEFORE it fell due: that review cannot have covered the recheck.
    expect(queueReason(verifiedOn('2026-07-20'))).toBe('stale');
    expect(reviewReasons(verifiedOn('2026-07-20'))).toEqual(['stale']);
  });

  it('never lets a process, an unreadable horizon or an undated stamp clear it', () => {
    const process = at(
      { stale_after: '2026-07-26', verified: [{ by: 'process:n', at: '2026-07-28T09:00:00Z' }] },
      'knowledge/a.md',
    );
    expect(queueReason(process)).toBe('stale');
    // `2026-7-1` is malformed (stale by the shared rule); no date compares
    // with it, so no review covers it.
    const malformed = at(
      { stale_after: '2026-7-1', verified: [{ by: 'human:josef', at: '2026-07-28T09:00:00Z' }] },
      'knowledge/a.md',
    );
    expect(malformed.stale).toBe(true);
    expect(queueReason(malformed)).toBe('stale');
    const undated = at(
      { stale_after: '2026-07-26', verified: [{ by: 'human:josef' }] },
      'knowledge/a.md',
    );
    expect(queueReason(undated)).toBe('stale');
    // A review that no longer covers the text covers no recheck either.
    const changed = at(
      { stale_after: '2026-07-26', verified: 'verified at r2; current is r3' },
      'knowledge/a.md',
    );
    expect(queueReason(changed)).toBe('changed');
  });

  // M52.4 — the horizon is judged as `isStale` judges it (raw, calendar-real),
  // and a stamp is compared as a day, never as the first ten characters.
  it('reads the horizon and the stamp as dates before letting a review cover it', () => {
    const covered = (staleAfter: string, stampAt: string, today = TODAY) =>
      reviewReasons(
        toConcept(
          concept(
            { stale_after: staleAfter, verified: [{ by: 'human:josef', at: stampAt }] },
            'knowledge/a.md',
          ),
          today,
        ),
      );
    // Padded: `concept.staleAfter` trims it, the shared rule calls it stale.
    expect(covered(' 2026-07-01', '2026-07-28T09:00:00Z')).toEqual(['stale']);
    // A day the calendar does not have.
    expect(covered('2026-02-30', '2026-03-01T09:00:00Z')).toEqual(['stale']);
    // Stamps that sort after any date as text, and are no later day.
    expect(covered('2026-09-01', 'yesterday', '2026-09-29')).toEqual(['stale']);
    expect(covered('2026-09-01', '2026-1-5', '2026-09-29')).toEqual(['stale']);
  });

  describe('on the reader’s calendar', () => {
    const tz = process.env.TZ;
    afterEach(() => {
      // Assigning `undefined` would set the string "undefined".
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    });

    it('counts a stamp on the day it fell where the person verified', () => {
      process.env.TZ = 'Australia/Sydney';
      const due = { stale_after: '2026-07-26' };
      // 22:00 UTC on the 25th is 08:00 on the 26th in Sydney.
      expect(localDayOf('2026-07-25T22:00:00Z')).toBe('2026-07-26');
      expect(
        reviewReasons(
          at(
            { ...due, verified: [{ by: 'human:me', at: '2026-07-25T22:00:00Z' }] },
            'knowledge/a.md',
          ),
        ),
      ).toEqual([]);
      expect(localDayOf('yesterday')).toBeNull();
    });

    it('keeps a date-only stamp as written, west of Greenwich too', () => {
      process.env.TZ = 'America/Los_Angeles';
      // `Date.parse` reads it as UTC midnight — the 25th, in Los Angeles.
      expect(localDayOf('2026-07-26')).toBe('2026-07-26');
      const due = { stale_after: '2026-07-26' };
      expect(
        reviewReasons(
          at({ ...due, verified: [{ by: 'human:me', at: '2026-07-26' }] }, 'knowledge/a.md'),
        ),
      ).toEqual([]);
      expect(
        reviewReasons(
          at({ ...due, verified: [{ by: 'human:me', at: '2026-07-25' }] }, 'knowledge/a.md'),
        ),
      ).toEqual(['stale']);
    });
  });

  it('says a stale concept is due, and how late only where the file says a readable date', () => {
    const line = (staleAfter: unknown, today = '2026-07-28') =>
      recheckLine(at({ stale_after: staleAfter }, 'knowledge/a.md'), today);
    // How late, in the words the table and the review bar share (M52.5).
    expect(line('2026-07-01')).toBe('Due a recheck · 27 days overdue');
    expect(line('2026-07-27')).toBe('Due a recheck · 1 day overdue');
    expect(line('2026-07-28')).toBe('Due a recheck today');
    expect(line('2026-03-01')).toBe('Due a recheck · 4 months overdue');
    for (const unreadable of ['', '   ', 2027, true, '2026-7-1']) {
      const stale = at({ stale_after: unreadable }, 'knowledge/a.md');
      expect(stale.stale, String(unreadable)).toBe(true);
      expect(line(unreadable), String(unreadable)).toBe(
        "Due a recheck — its recheck date can't be read",
      );
    }
    expect(readableHorizon('2026-02-30')).toBe(false);
    expect(readableHorizon(null)).toBe(false);
  });

  it('puts what a person must act on first, newest writing first within new', () => {
    const queue = reviewQueue([
      at({ generated: { by: 'claude-code', at: '2026-07-01T00:00:00Z' } }, 'knowledge/old.md'),
      at({ ...agent, lifecycle: 'deprecated' }, 'knowledge/retired.md'),
      at({ generated: { by: 'claude-code', at: '2026-07-20T00:00:00Z' } }, 'knowledge/fresh.md'),
      at({ ...agent, stale_after: '2026-02-01' }, 'knowledge/stale-late.md'),
      at({ ...agent, stale_after: '2026-01-01' }, 'knowledge/stale-early.md'),
      at(
        { stale_after: '2026-01-01', generated: { by: 'claude-code', at: '2026-06-01T00:00:00Z' } },
        'knowledge/unread-and-due.md',
      ),
      at(human, 'knowledge/done.md'),
    ]);
    expect(queue.map((q) => [q.concept.entry.path, q.reason])).toEqual([
      ['knowledge/stale-early.md', 'stale'],
      ['knowledge/stale-late.md', 'stale'],
      ['knowledge/retired.md', 'deprecated'],
      ['knowledge/fresh.md', 'new'],
      ['knowledge/old.md', 'new'],
      ['knowledge/unread-and-due.md', 'new'],
    ]);
  });
});

describe('reading one thread (M33a.4)', () => {
  const project = makeEntry({
    path: 'projects/phoenix/project.md',
    filename: 'project.md',
    folder: 'projects/phoenix',
    title: 'Phoenix warehouse rollout',
    type: 'Project',
  });

  const knows = (
    name: string,
    patch: {
      title?: string;
      type?: string;
      properties?: Record<string, unknown>;
      relations?: Record<string, string[]>;
    } = {},
  ): Entry =>
    makeEntry({
      path: `knowledge/${name}.md`,
      filename: `${name}.md`,
      folder: 'knowledge',
      title: patch.title ?? name,
      type: patch.type ?? 'Reference',
      relationships: { about: ['phoenix'], ...(patch.relations ?? {}) },
      properties: patch.properties,
    });

  const read = (entries: Entry[]) => {
    const concepts = listConcepts(entries, TODAY);
    const [subject] = listSubjects(concepts, entries);
    return readThread(subject, concepts, entries);
  };

  const titles = (reading: ReturnType<typeof read>) =>
    reading.known.flatMap((group) => group.concepts.map((c) => c.title));

  it('puts a replaced concept under contested and keeps it out of known', () => {
    const reading = read([
      project,
      knows('offline-window', { title: 'The offline window' }),
      knows('offline-guarantee', {
        title: 'The offline guarantee',
        relations: { supersedes: ['offline-window'] },
      }),
    ]);
    expect(reading.contested).toHaveLength(1);
    expect(reading.contested[0].concept.title).toBe('The offline window');
    expect(reading.contested[0].reason).toBe('replaced');
    expect(reading.contested[0].others.map((c) => c.title)).toEqual(['The offline guarantee']);
    // Known is the SETTLED remainder — a claim the bundle has retired is not
    // part of what it knows, and listing it under both would say it twice.
    expect(titles(reading)).toEqual(['The offline guarantee']);
  });

  it('reads a contradiction from either end', () => {
    const reading = read([
      project,
      knows('a-says', { title: 'A says', relations: { contradicts: ['b-says'] } }),
      knows('b-says', { title: 'B says' }),
    ]);
    // The end that never declared it is contested too: disagreement has no
    // direction, and only one of the two files carries the field.
    expect(reading.contested.map((c) => [c.concept.title, c.reason])).toEqual([
      ['A says', 'contradicted'],
      ['B says', 'contradicted'],
    ]);
    expect(titles(reading)).toEqual([]);
  });

  it('reports an undated concept rather than sorting it oldest', () => {
    const reading = read([
      project,
      knows('old', {
        title: 'Old',
        properties: { generated: { by: 'claude-code', at: '2026-05-01T00:00:00Z' } },
      }),
      knows('new', {
        title: 'New',
        properties: { generated: { by: 'claude-code', at: '2026-07-01T00:00:00Z' } },
      }),
      knows('undated', { title: 'Undated' }),
    ]);
    expect(reading.changed.map((c) => c.concept.title)).toEqual(['New', 'Old']);
    // Not last in `changed`: a missing stamp is not an early one, and giving
    // it a position is giving it a date it never carried.
    expect(reading.undated.map((c) => c.title)).toEqual(['Undated']);
  });

  it('contests nothing on a settled thread, and says so with an empty finding', () => {
    const reading = read([project, knows('one', { title: 'One', type: 'Metric' })]);
    expect(reading.contested).toEqual([]);
    expect(reading.known).toEqual([{ conceptType: 'Metric', concepts: [expect.anything()] }]);
  });

  it('keeps a stale concept out of known without calling it contested', () => {
    const reading = read([
      project,
      knows('due', { title: 'Due a recheck', properties: { stale_after: '2026-07-01' } }),
      knows('fresh', { title: 'Fresh' }),
    ]);
    expect(reading.stale.map((c) => c.title)).toEqual(['Due a recheck']);
    expect(reading.contested).toEqual([]);
    expect(titles(reading)).toEqual(['Fresh']);
  });

  it('dedupes sources by resource, counts what cites them, and counts what cites nothing', () => {
    const reading = read([
      project,
      knows('one', {
        title: 'One',
        properties: {
          sources: [
            { id: 'dec', resource: '/records/dec.md', title: 'The decision' },
            // The same artifact twice in one concept is one concept citing it.
            { id: 'dec-again', resource: '/records/dec.md' },
          ],
        },
      }),
      knows('two', {
        // `/records/dec.md` and `records/dec.md` name one file (§5.1).
        title: 'Two',
        properties: { sources: [{ id: 'dec', resource: 'records/dec.md' }] },
      }),
      knows('three', { title: 'Three' }),
    ]);
    expect(reading.sources).toEqual([
      { resource: '/records/dec.md', title: 'The decision', citedBy: 2 },
    ]);
    // Never absorbed into the total: a concept resting on nothing is exactly
    // what a reader of a reading list needs to be told about.
    expect(reading.uncited.map((c) => c.title)).toEqual(['Three']);
  });
});

describe('concept relations (M8.7)', () => {
  const project = makeEntry({
    path: 'projects/phoenix/project.md',
    filename: 'project.md',
    type: 'Project',
    title: 'Phoenix',
  });

  const c = (
    path: string,
    title: string,
    props: Record<string, unknown> = {},
    relationships: Record<string, string[]> = {},
  ) =>
    makeEntry({
      path,
      filename: path.split('/').pop(),
      properties: { title, about: ['[[phoenix]]'], ...props },
      relationships: { about: ['phoenix'], ...relationships },
    });

  it('reads supersession from the replacement, and marks the replaced one', () => {
    // The retired concept says nothing about being retired — it cannot, since
    // it was written before the thing that replaced it existed.
    const old = c('knowledge/a.md', 'Offline window');
    const now = c('knowledge/b.md', 'Offline window', {}, { supersedes: ['a'] });
    const concepts = listConcepts([project, old, now], TODAY);
    const byPath = Object.fromEntries(concepts.map((x) => [x.entry.path, x]));
    expect(byPath['knowledge/a.md'].supersededBy).toBe('knowledge/b.md');
    expect(byPath['knowledge/b.md'].supersededBy).toBeNull();
  });

  it('keeps a replaced concept out of the review queue', () => {
    // Verifying a claim something newer has already overridden is busywork.
    const old = c('knowledge/a.md', 'Offline window');
    const now = c('knowledge/b.md', 'Offline window', {}, { supersedes: ['a'] });
    const concepts = listConcepts([project, old, now], TODAY);
    const replaced = concepts.find((x) => x.entry.path === 'knowledge/a.md');
    expect(needsReview(replaced!)).toBe(false);
    expect(reviewReasons(replaced!)).toEqual([]);
  });

  it('shows an edge from both ends, labelled for the end you are standing on', () => {
    const old = c('knowledge/a.md', 'Offline window');
    const now = c('knowledge/b.md', 'Offline window', {}, { supersedes: ['a'] });
    const entries = [project, old, now];
    const concepts = listConcepts(entries, TODAY);
    const [first, second] = concepts;

    const inbound = conceptEdges(first, concepts, entries);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({ direction: 'in', label: 'Replaced by' });

    const outbound = conceptEdges(second, concepts, entries);
    expect(outbound[0]).toMatchObject({ direction: 'out', label: 'Replaces' });
  });

  it('accepts a bundle-relative path as well as a wikilink', () => {
    // OKF §6.1 recommends `/systems/x.md`; the agent writes wikilinks
    // everywhere else. Refusing either would lose a real edge over syntax.
    const old = c('knowledge/systems/a.md', 'Offline window');
    const now = c('knowledge/b.md', 'Offline window', { supersedes: ['/systems/a.md'] });
    const concepts = listConcepts([project, old, now], TODAY);
    expect(concepts.find((x) => x.entry.path === 'knowledge/systems/a.md')?.supersededBy).toBe(
      'knowledge/b.md',
    );
  });

  it('an unreviewed replacement of a human-reviewed claim is only proposed (M49.8, K22)', () => {
    const old = c('knowledge/a.md', 'Offline window', {
      verified: { by: 'human:josef', at: '2026-07-01' },
    });
    const now = c('knowledge/b.md', 'Offline window', {}, { supersedes: ['a'] });
    const concepts = listConcepts([project, old, now], TODAY);
    const a = concepts.find((x) => x.entry.path === 'knowledge/a.md')!;
    expect(a.supersededBy).toBeNull();
    expect(a.replacementProposedBy).toBe('knowledge/b.md');
  });

  it('a replacement a person approved on its card retires the reviewed claim (M49.8, K22)', () => {
    const old = c('knowledge/a.md', 'Offline window', {
      verified: { by: 'human:josef', at: '2026-07-01' },
    });
    const now = c('knowledge/b.md', 'Offline window', {}, { supersedes: ['a'] });
    const approved = new Set([supersessionKey('knowledge/b.md', 'knowledge/a.md')]);
    const concepts = listConcepts([project, old, now], TODAY, NO_QUARANTINE, {
      approved,
      recordedHuman: null,
    });
    const a = concepts.find((x) => x.entry.path === 'knowledge/a.md')!;
    expect(a.supersededBy).toBe('knowledge/b.md');
    expect(a.replacementProposedBy).toBeNull();
  });

  it("who reviewed is the LEDGER's answer when one exists, as Rust `about` reads it (M49.8)", () => {
    // A stamp typed into the file the ledger never recorded as a person's
    // does not shield the concept; one the ledger records does, whatever the
    // file now says.
    const typed = c('knowledge/a.md', 'Offline window', {
      verified: { by: 'human:someone', at: '2026-07-01' },
    });
    const now = c('knowledge/b.md', 'Offline window', {}, { supersedes: ['a'] });
    const unshielded = listConcepts([project, typed, now], TODAY, NO_QUARANTINE, {
      approved: new Set(),
      recordedHuman: new Set(),
    });
    expect(unshielded.find((x) => x.entry.path === 'knowledge/a.md')!.supersededBy).toBe(
      'knowledge/b.md',
    );
    const plain = c('knowledge/a.md', 'Offline window');
    const shielded = listConcepts([project, plain, now], TODAY, NO_QUARANTINE, {
      approved: new Set(),
      recordedHuman: new Set(['knowledge/a.md']),
    });
    expect(shielded.find((x) => x.entry.path === 'knowledge/a.md')!.replacementProposedBy).toBe(
      'knowledge/b.md',
    );
  });

  it('two concepts that each claim to replace the other retire neither (M49.8, K22)', () => {
    const a = c('knowledge/a.md', 'Offline window', {}, { supersedes: ['b'] });
    const b = c('knowledge/b.md', 'Offline window', {}, { supersedes: ['a'] });
    const concepts = listConcepts([project, a, b], TODAY);
    for (const concept of concepts) {
      expect(concept.supersededBy).toBeNull();
      expect(concept.replacementProposedBy).not.toBeNull();
    }
  });

  it('a review claimed by a file that is not the recorded one reads disputed (M49.8, K21)', () => {
    const stamped = c('knowledge/a.md', 'Offline window', {
      verified: { by: 'human:josef', at: '2026-07-01' },
    });
    const [trusted] = listConcepts([project, stamped], TODAY);
    expect(trusted.review).toBe('current');
    expect(humanReviewed(trusted)).toBe(true);

    const [disputed] = listConcepts([project, stamped], TODAY, new Set(['knowledge/a.md']));
    expect(disputed.review).toBe('disputed');
    expect(humanReviewed(disputed)).toBe(false);
    expect(needsReview(disputed)).toBe(true);
  });

  it('never lets a concept supersede itself', () => {
    const self = c('knowledge/a.md', 'Offline window', {}, { supersedes: ['a'] });
    const concepts = listConcepts([project, self], TODAY);
    expect(concepts[0].supersededBy).toBeNull();
    expect(conceptEdges(concepts[0], concepts, [project, self])).toEqual([]);
  });
});

describe('nearDuplicates', () => {
  const project = makeEntry({
    path: 'projects/phoenix/project.md',
    filename: 'project.md',
    type: 'Project',
    title: 'Phoenix',
  });
  const atlas = makeEntry({
    path: 'projects/atlas/project.md',
    filename: 'project.md',
    type: 'Project',
    title: 'Atlas',
  });

  const c = (path: string, title: string, about: string, rel: Record<string, string[]> = {}) =>
    makeEntry({
      path,
      filename: path.split('/').pop(),
      properties: { title },
      relationships: { about: [about], ...rel },
    });

  it('needs BOTH a shared anchor and an overlapping title', () => {
    const entries = [
      project,
      atlas,
      c('knowledge/a.md', 'Pick queue drain time', 'phoenix'),
      // Same project, one shared word, different subject.
      c('knowledge/b.md', 'Pick list generation', 'phoenix'),
      // Same subject, different project.
      c('knowledge/c.md', 'Pick queue drain time', 'atlas'),
      // Both — the only real duplicate.
      c('knowledge/d.md', 'Drain time for the pick queue', 'phoenix'),
    ];
    const concepts = listConcepts(entries, TODAY);
    const subject = concepts.find((x) => x.entry.path === 'knowledge/a.md')!;
    expect(nearDuplicates(subject, concepts, entries).map((x) => x.entry.path)).toEqual([
      'knowledge/d.md',
    ]);
  });

  it('stops calling a pair duplicates once a relation resolves it', () => {
    const entries = [
      project,
      c('knowledge/a.md', 'Pick queue drain time', 'phoenix'),
      c('knowledge/d.md', 'Drain time for the pick queue', 'phoenix', { supersedes: ['a'] }),
    ];
    const concepts = listConcepts(entries, TODAY);
    const subject = concepts.find((x) => x.entry.path === 'knowledge/a.md')!;
    expect(nearDuplicates(subject, concepts, entries)).toEqual([]);
  });

  it('says nothing about an unanchored concept', () => {
    // Without an anchor there is no evidence two concepts are about the same
    // thing, and a title match alone would flag every "Overview" in the base.
    const loose = makeEntry({
      path: 'knowledge/a.md',
      filename: 'a.md',
      properties: { title: 'Pick queue drain time' },
    });
    const other = c('knowledge/b.md', 'Pick queue drain time', 'phoenix');
    const entries = [project, loose, other];
    const concepts = listConcepts(entries, TODAY);
    expect(nearDuplicates(concepts[0], concepts, entries)).toEqual([]);
  });
});

describe('commitOf — has this note been committed to the knowledge base?', () => {
  const from = (path: string, resources: string[], at = '2026-07-28T10:00:00Z') =>
    makeEntry({
      path,
      filename: path.split('/').pop(),
      properties: {
        sources: resources.map((resource, i) => ({ id: `s${i}`, resource })),
        generated: { by: 'claude-code', at },
      },
    });

  const note = (patch = {}) =>
    makeEntry({ path: 'inbox/standup.md', filename: 'standup.md', ...patch });

  it('is uncommitted when nothing in the bundle cites it', () => {
    const concepts = listConcepts([from('knowledge/a.md', ['inbox/other.md'])], TODAY);
    expect(commitOf(note(), concepts)).toMatchObject({ state: 'uncommitted', at: null });
  });

  it('finds the concepts distilled from it, however the resource was written', () => {
    const concepts = listConcepts(
      [from('knowledge/a.md', ['/inbox/standup.md']), from('knowledge/b.md', ['inbox/standup.md'])],
      TODAY,
    );
    const commit = commitOf(note(), concepts);
    expect(commit.state).toBe('committed');
    expect(commit.concepts.map((c) => c.entry.path)).toEqual(['knowledge/a.md', 'knowledge/b.md']);
  });

  it('reports the newest learning, not the first one found', () => {
    const concepts = listConcepts(
      [
        from('knowledge/a.md', ['inbox/standup.md'], '2026-07-20T09:00:00Z'),
        from('knowledge/b.md', ['inbox/standup.md'], '2026-07-26T09:00:00Z'),
      ],
      TODAY,
    );
    expect(commitOf(note(), concepts).at).toBe('2026-07-26T09:00:00Z');
  });

  it('falls behind when the note is edited after it was learned from', () => {
    const concepts = listConcepts([from('knowledge/a.md', ['inbox/standup.md'])], TODAY);
    const edited = note({ modifiedAt: '2026-07-29T12:00:00Z' });
    expect(commitOf(edited, concepts).state).toBe('behind');
    // Editing it BEFORE the distillation is the ordinary case, not a warning.
    expect(commitOf(note({ modifiedAt: '2026-07-27T12:00:00Z' }), concepts).state).toBe(
      'committed',
    );
  });

  it('does not manufacture work from an unstamped concept', () => {
    // No `generated` at all: nothing to compare the edit against, so the
    // commit reads as current rather than permanently behind.
    const unstamped = makeEntry({
      path: 'knowledge/a.md',
      filename: 'a.md',
      properties: { sources: [{ id: 's', resource: 'inbox/standup.md' }] },
    });
    const commit = commitOf(
      note({ modifiedAt: '2027-01-01T00:00:00Z' }),
      listConcepts([unstamped], TODAY),
    );
    expect(commit.state).toBe('committed');
    expect(commit.at).toBeNull();
  });

  it('ignores a source entry that names no resource', () => {
    const junk = makeEntry({
      path: 'knowledge/a.md',
      filename: 'a.md',
      properties: { sources: [{ id: 'orphan' }] },
    });
    expect(conceptsFrom('inbox/standup.md', listConcepts([junk], TODAY))).toEqual([]);
  });
});

describe('knowledgeOf — both directions, each concept once (M52.3)', () => {
  const standup = makeEntry({ path: 'inbox/standup.md', filename: 'standup.md', title: 'Standup' });
  const concept = (path: string, relationships: Record<string, string[]>, resources: string[]) =>
    makeEntry({
      path,
      filename: path.split('/').pop(),
      properties: { sources: resources.map((resource, i) => ({ id: `s${i}`, resource })) },
      relationships,
    });

  it('names what is about the page and what was learned from it', () => {
    const entries = [
      standup,
      concept('knowledge/a.md', { about: ['standup'] }, []),
      concept('knowledge/b.md', {}, ['/inbox/standup.md']),
      concept('knowledge/c.md', {}, ['inbox/other.md']),
    ];
    const { about, from } = knowledgeOf('inbox/standup.md', listConcepts(entries, TODAY), entries);
    expect(about.map((c) => c.entry.path)).toEqual(['knowledge/a.md']);
    expect(from.map((c) => c.entry.path)).toEqual(['knowledge/b.md']);
  });

  it('files a concept that is about the page AND cites it under about, once', () => {
    const entries = [
      standup,
      concept('knowledge/both.md', { about: ['standup'] }, ['inbox/standup.md']),
    ];
    const { about, from } = knowledgeOf('inbox/standup.md', listConcepts(entries, TODAY), entries);
    expect(about.map((c) => c.entry.path)).toEqual(['knowledge/both.md']);
    expect(from).toEqual([]);
  });
});

describe('relatedConcepts', () => {
  const project = makeEntry({
    path: 'projects/phoenix/project.md',
    filename: 'project.md',
    folder: 'projects/phoenix',
    title: 'Phoenix warehouse rollout',
    type: 'Project',
  });
  const risk = makeEntry({
    path: 'records/risks/risk-rollback.md',
    filename: 'risk-rollback.md',
    title: 'Rollback unrehearsed',
    type: 'Risk',
  });
  const about = (path: string, title: string, targets: string[]) =>
    makeEntry({
      path,
      filename: path.split('/').pop(),
      title,
      type: 'Reference',
      relationships: { about: targets },
    });

  const cutover = about('knowledge/playbooks/cutover.md', 'Cutover', ['phoenix', 'risk-rollback']);
  const guarantee = about('knowledge/systems/guarantee.md', 'Guarantee', ['risk-rollback']);
  const unrelated = about('knowledge/metrics/other.md', 'Other', ['something-else']);
  const entries = [project, risk, cutover, guarantee, unrelated];
  const concepts = () => listConcepts(entries, TODAY);

  it('finds knowledge about the project a note lives in, unreferenced', () => {
    // The whole point of the surface: a PRD in projects/phoenix/ is about
    // Phoenix whether or not it ever writes the word.
    const prd = makeEntry({
      path: 'projects/phoenix/prd.md',
      filename: 'prd.md',
      folder: 'projects/phoenix',
      project: 'projects/phoenix/project.md',
      title: 'Cutover PRD',
    });
    expect(relatedConcepts(prd, concepts(), [...entries, prd]).map((c) => c.title)).toContain(
      'Cutover',
    );
  });

  it("follows the note's own links and frontmatter relations", () => {
    const note = makeEntry({
      path: 'docs/note.md',
      filename: 'note.md',
      title: 'Note',
      outgoingLinks: ['risk-rollback'],
    });
    // Both concepts match the one linked risk, so they tie on relevance and
    // fall back to title order — deterministic, not arbitrary.
    const found = relatedConcepts(note, concepts(), [...entries, note]);
    expect(found.map((c) => c.title)).toEqual(['Cutover', 'Guarantee']);

    const related = makeEntry({
      path: 'docs/other.md',
      filename: 'other.md',
      title: 'Other',
      relationships: { affects: ['phoenix'] },
    });
    expect(relatedConcepts(related, concepts(), [...entries, related])).toHaveLength(1);
  });

  it('ranks a concept matching several subjects above one that clipped a link', () => {
    const note = makeEntry({
      path: 'projects/phoenix/prd.md',
      filename: 'prd.md',
      folder: 'projects/phoenix',
      project: 'projects/phoenix/project.md',
      title: 'PRD',
      outgoingLinks: ['risk-rollback'],
    });
    const found = relatedConcepts(note, concepts(), [...entries, note]);
    expect(found[0].entry.path).toBe('knowledge/playbooks/cutover.md');
  });

  it('never recommends a concept to itself', () => {
    expect(relatedConcepts(cutover, concepts(), entries).map((c) => c.entry.path)).not.toContain(
      'knowledge/playbooks/cutover.md',
    );
  });

  it('returns nothing for a note that shares no subject', () => {
    const stray = makeEntry({ path: 'docs/stray.md', filename: 'stray.md', title: 'Stray' });
    expect(relatedConcepts(stray, concepts(), [...entries, stray])).toEqual([]);
  });
});

describe('resolveBundleLink', () => {
  it('reads a leading slash as bundle-relative, not filesystem-absolute', () => {
    expect(resolveBundleLink('/metrics/a.md', 'knowledge/log.md')).toEqual({
      internal: 'knowledge/metrics/a.md',
    });
  });

  it('resolves ./ and ../ against the concept holding the link', () => {
    expect(resolveBundleLink('./b.md', 'knowledge/metrics/a.md')).toEqual({
      internal: 'knowledge/metrics/b.md',
    });
    expect(resolveBundleLink('../systems/b.md', 'knowledge/metrics/a.md')).toEqual({
      internal: 'knowledge/systems/b.md',
    });
  });

  it('treats anything with a scheme as external', () => {
    expect(resolveBundleLink('https://x.test/a', 'knowledge/a.md')).toEqual({
      external: 'https://x.test/a',
    });
  });
});

describe('parseLog', () => {
  const LOG = [
    '# Knowledge Update Log',
    '',
    '## 2026-07-28',
    '* **Creation**: Drafted [Warehouse cutover](/playbooks/warehouse-cutover.md) from the',
    '  rollout project and the open rollback risk.',
    '',
    '## 2026-07-27',
    '* **Deprecation**: Marked [Webinar attendance](/metrics/webinar-attendance.md) deprecated.',
    '* A change nobody labelled.',
  ].join('\n');

  it('groups entries under their date heading', () => {
    const days = parseLog(LOG);
    expect(days.map((d) => d.date)).toEqual(['2026-07-28', '2026-07-27']);
    expect(days[1].entries).toHaveLength(2);
  });

  it('joins a bullet that wraps across lines', () => {
    // Hard-wrapped source must not become two half-sentences.
    expect(parseLog(LOG)[0].entries[0].text).toContain('from the rollout project');
  });

  it('classifies the labelled kinds and tolerates an unlabelled one', () => {
    const days = parseLog(LOG);
    expect(days[0].entries[0].kind).toBe('creation');
    expect(days[1].entries[0].kind).toBe('deprecation');
    expect(days[1].entries[1].kind).toBe('note');
    expect(days[1].entries[1].label).toBeNull();
  });

  it('resolves the concept each entry points at', () => {
    expect(parseLog(LOG)[0].entries[0].links).toEqual([
      { label: 'Warehouse cutover', path: 'knowledge/playbooks/warehouse-cutover.md', url: null },
    ]);
  });

  it('drops a date heading with nothing under it', () => {
    expect(parseLog('## 2026-07-28\n\n## 2026-07-27\n* **Update**: x')).toHaveLength(1);
  });
});

describe('footnoteRefs', () => {
  it('collects citation labels but not their definitions', () => {
    const body = [
      'The table is sharded daily.[^ga4-schema]',
      'Revenue excludes tax.[^policy][^ga4-schema]',
      '',
      '[^ga4-schema]: GA4 BigQuery Export schema',
      '[^policy]: Revenue recognition policy',
    ].join('\n');
    expect(footnoteRefs(body).sort()).toEqual(['ga4-schema', 'policy']);
  });
});

describe('staleness — the shared rule (M49.8, K24)', () => {
  it('replays shared/policy/staleness.v1.json, the cases knowledge.rs replays too', () => {
    for (const c of STALENESS_CASES.cases) {
      expect(staleFrom(staleAfterOf(c.stale_after), c.today), JSON.stringify(c)).toBe(c.stale);
    }
  });
});
