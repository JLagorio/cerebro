import { describe, expect, it } from 'vitest';
import {
  commitOf,
  conceptEdges,
  conceptsAbout,
  conceptsFrom,
  footnoteRefs,
  nearDuplicates,
  isConcept,
  isKnowledgePath,
  isStale,
  lastVerifiedAt,
  lifecycleOf,
  listConcepts,
  listSections,
  listSubjects,
  needsReview,
  parseAbout,
  parseActor,
  parseGenerated,
  parseLog,
  parseSources,
  parseVerified,
  recentlyLearned,
  relatedConcepts,
  resolveBundleLink,
  reviewReasons,
  sectionOf,
  toConcept,
  trustTier,
  verifyPatch,
} from './okf';
import { makeEntry } from './testHelpers';

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

describe('trust tiers', () => {
  it('reads absent verification as unverified', () => {
    expect(trustTier(concept({}))).toBe('unverified');
  });

  it('separates machine confirmation from human review', () => {
    const machine = concept({ verified: [{ by: 'process:nightly', at: '2026-07-01T00:00:00Z' }] });
    expect(trustTier(machine)).toBe('machine-confirmed');

    const human = concept({
      verified: [
        { by: 'process:nightly', at: '2026-07-01T00:00:00Z' },
        { by: 'human:josef', at: '2026-07-20T00:00:00Z' },
      ],
    });
    expect(trustTier(human)).toBe('human-reviewed');
  });

  it('treats a bare verified mapping as a one-element list', () => {
    // §5.2 MUST — producers may omit the list dash for a single verifier.
    const bare = concept({ verified: { by: 'human:josef', at: '2026-07-20T00:00:00Z' } });
    expect(parseVerified(bare)).toHaveLength(1);
    expect(trustTier(bare)).toBe('human-reviewed');
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
    expect(c.trust).toBe('unverified');
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
