// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  evaluateRetrieval,
  parseRetrievalCorpus,
  parseRetrievalLabels,
  parseRetrievalQueries,
  type RetrievalCorpus,
  type RetrievalLabels,
  type RetrievalObservation,
  type RetrievalQuery,
} from './outcomes/retrieval';

// These are evaluator probes, not native producer observations or a quality baseline.
const query: RetrievalQuery = {
  id: 'q',
  kind: 'exact',
  text: 'harbor budget',
  readPrefixes: ['visible'],
  requestedLimit: null,
};
const corpus: RetrievalCorpus = {
  version: 1,
  provenance: { synthetic: true, author: 'test fixture', note: 'No user content.' },
  documents: [
    { path: 'visible/a.md', markdown: '# A\n\nHarbor budget is 42.\n' },
    { path: 'visible/b.md', markdown: '# B\n\nHarbor budget was superseded.\n' },
    { path: 'hidden/c.md', markdown: '# C\n\nHidden budget is 99.\n' },
  ],
};
const labels = (judgments: RetrievalLabels['judgments']): RetrievalLabels => ({
  version: 1,
  provenance: {
    author: 'synthetic evaluator fixture',
    basis: 'Only these literal supplied passages.',
  },
  passages: [
    { id: 'a', path: 'visible/a.md', quote: 'Harbor budget is 42.' },
    { id: 'b', path: 'visible/b.md', quote: 'Harbor budget was superseded.' },
    { id: 'c', path: 'hidden/c.md', quote: 'Hidden budget is 99.' },
  ],
  judgments,
});
const judgment = (
  passageId: string,
  role: 'supporting' | 'counterevidence' | 'irrelevant' = 'supporting',
  review: 'proposed' | 'accepted' | 'disputed' = 'accepted',
): RetrievalLabels['judgments'][number] => ({
  queryId: 'q',
  passageId,
  role,
  review,
  rationale: 'Synthetic test label, not reviewed product evidence.',
});
const observed = (overrides: Partial<RetrievalObservation> = {}): RetrievalObservation => ({
  queryId: 'q',
  state: 'ready',
  effectiveLimit: 20,
  hits: ['visible/a.md'],
  admittedPaths: ['visible/a.md', 'visible/b.md'],
  durationMs: 2,
  costUsd: null,
  cappedSourceCount: 0,
  withheldSourceCount: 1,
  limitations: ['Synthetic evaluator probe; no native execution.'],
  ...overrides,
});

describe('M97.7 retrieval baseline contract', () => {
  it('counts relevant sources at the observed default20 and does not invent a rank21 hit', () => {
    const hits = ['visible/a.md', ...Array.from({ length: 19 }, (_, i) => 'visible/d' + i + '.md')];
    const result = evaluateRetrieval([query], labels([judgment('a'), judgment('b')]), () =>
      observed({ hits, admittedPaths: [...hits, 'visible/b.md'] }),
    );
    expect(result.queries[0].effectiveLimit).toBe(20);
    expect(result.queries[0].recall).toEqual({ found: 1, eligible: 2, ratio: 0.5 });
  });

  it('rejects more returned hits than the actual cutoff rather than truncating evidence', () => {
    const hits = Array.from({ length: 21 }, (_, i) => 'visible/d' + i + '.md');
    expect(() =>
      evaluateRetrieval([query], labels([judgment('a')]), () => observed({ hits })),
    ).toThrow('Retrieval observation exceeds its recorded cutoff.');
  });

  it('keeps unavailable corpus distinct from a measured empty result', () => {
    const result = evaluateRetrieval([query], labels([judgment('a')]), () =>
      observed({
        state: 'unavailable',
        effectiveLimit: null,
        hits: [],
        admittedPaths: [],
        durationMs: null,
        cappedSourceCount: null,
        withheldSourceCount: null,
      }),
    );
    expect(result.status).toBe('unavailable');
    expect(result.queries[0].recall).toBeNull();
    expect(result.queries[0].emptyRetrieval).toBeNull();
    expect(result.queries[0].durationMs).toBeNull();
  });

  it('reports a real empty read without claiming model abstention or answer support', () => {
    const result = evaluateRetrieval([query], labels([judgment('a')]), () =>
      observed({ hits: [] }),
    );
    expect(result.queries[0].recall).toEqual({ found: 0, eligible: 1, ratio: 0 });
    expect(result.queries[0].emptyRetrieval).toBe(true);
    expect(result.queries[0].answerSupport).toBeNull();
    expect(result.queries[0].modelAbstention).toBeNull();
  });

  it('keeps unknown cost null and counts it even when another query recorded zero', () => {
    const second = { ...query, id: 'q2' };
    const set = labels([judgment('a'), { ...judgment('a'), queryId: 'q2' }]);
    const result = evaluateRetrieval([query, second], set, (q) =>
      observed({
        queryId: q.id,
        costUsd: q.id === 'q' ? null : 0,
      }),
    );
    expect(result.queries.map((q) => q.costUsd)).toEqual([null, 0]);
    expect(result.usage).toEqual({ costUsd: null, unrecordedCostQueries: 1 });
  });

  it('rejects contradictory accepted judgments for one query and passage', () => {
    const raw = labels([judgment('a'), judgment('a', 'irrelevant')]);
    expect(() => parseRetrievalLabels(raw, [query], corpus)).toThrow(
      'Conflicting relevance labels.',
    );
  });

  it('rejects a label quote that is absent from its declared synthetic source', () => {
    const raw = labels([judgment('a')]);
    raw.passages[0].quote = 'An invented passage.';
    expect(() => parseRetrievalLabels(raw, [query], corpus)).toThrow(
      'Label passage is not unique in its source.',
    );
  });

  it('excludes proposed and disputed labels from accepted denominators and discloses both', () => {
    const result = evaluateRetrieval(
      [query],
      labels([
        judgment('a', 'supporting', 'proposed'),
        judgment('b', 'counterevidence', 'disputed'),
      ]),
      () => observed(),
    );
    expect(result.status).toBe('provisional');
    expect(result.queries[0].recall).toBeNull();
    expect(result.queries[0].counterevidence).toBeNull();
    expect(result.queries[0].excludedLabels).toEqual({ proposed: 1, disputed: 1, outsideScope: 0 });
  });

  it('counts counterevidence separately and removes ungranted labels from the denominator', () => {
    const result = evaluateRetrieval(
      [query],
      labels([judgment('a'), judgment('b', 'counterevidence'), judgment('c')]),
      () => observed({ hits: ['visible/a.md', 'visible/b.md'] }),
    );
    expect(result.queries[0].recall).toEqual({ found: 2, eligible: 2, ratio: 1 });
    expect(result.queries[0].counterevidence).toEqual({ found: 1, eligible: 1, ratio: 1 });
    expect(result.queries[0].excludedLabels.outsideScope).toBe(1);
  });

  it('fails scope leakage even when all relevant sources were retrieved', () => {
    const result = evaluateRetrieval([query], labels([judgment('a')]), () =>
      observed({
        hits: ['visible/a.md', 'hidden/c.md'],
      }),
    );
    expect(result.status).toBe('failed');
    expect(result.queries[0].hardGates.scopeLeakCount).toBe(1);
    expect(result.queries[0].recall).toEqual({ found: 1, eligible: 1, ratio: 1 });
  });

  it('does not pass label expectations into the observation producer', () => {
    const seen: unknown[] = [];
    evaluateRetrieval([query], labels([judgment('a')]), (q) => {
      seen.push(q);
      return observed();
    });
    expect(seen).toEqual([query]);
    expect(Object.keys(seen[0] as object).sort()).toEqual([
      'id',
      'kind',
      'readPrefixes',
      'requestedLimit',
      'text',
    ]);
  });

  it('accepts a bounded corpus and query set but refuses path escapes and duplicate query identities', () => {
    expect(parseRetrievalCorpus(corpus)).toEqual(corpus);
    expect(parseRetrievalQueries({ version: 1, queries: [query] })).toEqual([query]);
    expect(() =>
      parseRetrievalCorpus({ ...corpus, documents: [{ path: '../outside.md', markdown: 'x' }] }),
    ).toThrow('Unsafe retrieval fixture path.');
    expect(() => parseRetrievalQueries({ version: 1, queries: [query, query] })).toThrow(
      'Duplicate retrieval query identity.',
    );
  });
});
