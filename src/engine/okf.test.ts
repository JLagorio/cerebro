import { describe, expect, it } from 'vitest';
import {
  footnoteRefs,
  isConcept,
  isKnowledgePath,
  isStale,
  lastVerifiedAt,
  lifecycleOf,
  listConcepts,
  needsReview,
  parseActor,
  parseGenerated,
  parseSources,
  parseVerified,
  reviewReasons,
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
      sources: [
        { resource: 'x', usage_window: { from: '2026-01-01', to: '2026-01-31' } },
      ],
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

    const reviewed = toConcept(concept({ verified: [{ by: 'human:josef', at: '2026-07-01' }] }), TODAY);
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
