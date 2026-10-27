// @vitest-environment node
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import corpusArtifact from '../conformance/retrieval/corpus.v1.json';
import queryArtifact from '../conformance/retrieval/queries.json';
import validationCases from '../conformance/retrieval/validation-cases.v1.json';
import wireCases from '../conformance/retrieval/wire-cases.v1.json';
import {
  evaluateRetrieval,
  loadRetrievalFixtures,
  parseRetrievalCorpus,
  parseRetrievalLabels,
  parseRetrievalQueries,
  parseRetrievalObservation,
  readRetrievalJson,
  validateRetrievalCapture,
  type RetrievalCorpus,
  type RetrievalFixtures,
  type RetrievalLabels,
  type RetrievalNativeCapture,
  type RetrievalObservation,
  type RetrievalQuery,
} from './outcomes/retrieval';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const q: RetrievalQuery = {
  id: 'q',
  kind: 'exact',
  text: 'harbor budget',
  readPrefixes: ['visible'],
  requestedLimit: null,
};
const corpus: RetrievalCorpus = {
  version: 1,
  provenance: {
    synthetic: true,
    author: 'synthetic importer probe',
    note: 'Not a native execution.',
  },
  documents: [
    { path: 'visible/a.md', markdown: '# A\n\nHarbor budget is42.\n' },
    { path: 'visible/b.md', markdown: '# B\n\nRevised budget is44.\n' },
    { path: 'hidden/c.md', markdown: '# C\n\nHidden fixture only.\n' },
  ],
};
const labels: RetrievalLabels = {
  version: 1,
  provenance: {
    author: 'synthetic evaluator',
    basis: 'These unit labels do not change the proposed baseline artifact.',
  },
  passages: [
    { id: 'a', path: 'visible/a.md', quote: 'Harbor budget is42.' },
    { id: 'b', path: 'visible/b.md', quote: 'Revised budget is44.' },
  ],
  judgments: [
    {
      queryId: 'q',
      passageId: 'a',
      role: 'supporting',
      review: 'accepted',
      rationale: 'Synthetic unit label.',
    },
  ],
};
const observation = (): RetrievalObservation => ({
  queryId: 'q',
  state: 'ready',
  effectiveLimit: 20,
  hits: ['visible/a.md'],
  admittedPaths: ['visible/a.md', 'visible/b.md'],
  durationMs: 1,
  costUsd: null,
  cappedSourceCount: 0,
  withheldSourceCount: 1,
  limitations: ['Synthetic importer/evaluator probe only.'],
});
const identity = {
  version: 1 as const,
  aggregateDigest: 'e'.repeat(64),
  fileCount: 10,
  totalBytes: 100,
};
const fixtures: RetrievalFixtures = {
  corpus,
  queries: [q],
  labels,
  digests: {
    corpus: 'a'.repeat(64),
    queries: 'b'.repeat(64),
    labels: 'c'.repeat(64),
    format: 'd'.repeat(64),
  },
};
const capture = (): RetrievalNativeCapture => ({
  version: 1,
  scenario: 'retrieval',
  producer: 'mcp::search_notes_in',
  observedAt: '2026-10-25T00:00:00Z',
  clock: 'native_monotonic_per_query',
  nativeInputs: { ...identity },
  corpusSha256: fixtures.digests.corpus,
  queriesSha256: fixtures.digests.queries,
  formatSha256: fixtures.digests.format,
  sourceFiles: corpus.documents.map((source) => ({
    path: source.path,
    bytes: Buffer.byteLength(source.markdown),
    sha256: hash(source.markdown),
  })),
  observations: [
    {
      observation: observation(),
      wireText:
        '1 of 1 note matches "harbor budget", best first (1 notes outside this run\'s read scope were not searched):\n- visible/a.md — A\n  L3: Harbor budget is42.',
      errorCode: null,
      sourceAudit: {
        verifiedBefore: 3,
        verifiedAfter: 3,
        missing: 0,
        changed: 0,
        additional: 0,
        symlinks: 0,
        unchanged: true,
      },
    },
  ],
  limits: ['Handwritten synthetic importer probe, not a compiled native capture.'],
});

function changedFixture(testCase: (typeof validationCases.cases)[number]) {
  const corpus = structuredClone(corpusArtifact);
  const queries = structuredClone(queryArtifact);
  if (testCase.target !== 'none') {
    let parent: unknown = testCase.target === 'corpus' ? corpus : queries;
    const parts = testCase.pointer.split('/').slice(1);
    for (const part of parts.slice(0, -1)) {
      if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, part))
        throw new Error('Bad shared fixture mutation.');
      parent = (parent as Record<string, unknown>)[part];
    }
    if (parent === null || typeof parent !== 'object' || Array.isArray(parent))
      throw new Error('Bad shared fixture mutation parent.');
    const key = parts.at(-1)!;
    if (testCase.operation === 'remove') delete (parent as Record<string, unknown>)[key];
    else (parent as Record<string, unknown>)[key] = structuredClone(testCase.value);
  }
  return { corpus, queries };
}

describe('M97.7 shared fixture inputs', () => {
  for (const testCase of validationCases.cases)
    it(testCase.name, () => {
      const input = changedFixture(testCase);
      const read = () => {
        parseRetrievalCorpus(input.corpus);
        parseRetrievalQueries(input.queries);
      };
      if (testCase.valid) expect(read).not.toThrow();
      else expect(read).toThrow();
    });
  it('loads the bounded long source without weakening the ordinary outcome reader', () => {
    const inputs = loadRetrievalFixtures();
    expect(
      inputs.corpus.documents.some((source) => Buffer.byteLength(source.markdown) > 102400),
    ).toBe(true);
    expect(inputs.labels.judgments).toHaveLength(37);
    expect(inputs.labels.judgments.every((label) => label.review === 'accepted')).toBe(true);
    expect(inputs.labels.provenance.author).toContain('independent review: Codex');
  });
  it('refuses a per-file and total corpus overrun at the pure boundary', () => {
    expect(() =>
      parseRetrievalCorpus({
        ...corpus,
        documents: [{ path: 'visible/a.md', markdown: 'x'.repeat(163841) }],
      }),
    ).toThrow();
    expect(() =>
      parseRetrievalCorpus({
        ...corpus,
        documents: Array.from({ length: 8 }, (_, index) => ({
          path: 'visible/' + index + '.md',
          markdown: 'x'.repeat(150000),
        })),
      }),
    ).toThrow('Retrieval corpus byte cap exceeded.');
  });
  it('refuses case-folded file collisions and file-as-directory fixture paths', () => {
    expect(() =>
      parseRetrievalCorpus({
        ...corpus,
        documents: [
          { path: 'visible/a.md', markdown: '' },
          { path: 'visible/A.md', markdown: '' },
        ],
      }),
    ).toThrow('Duplicate retrieval source path.');
    expect(() =>
      parseRetrievalCorpus({
        ...corpus,
        documents: [
          { path: 'visible/a.md', markdown: '' },
          { path: 'visible/a.md/b.md', markdown: '' },
        ],
      }),
    ).toThrow('Retrieval source path is also a directory.');
  });
});

describe('M97.7 evaluator hard boundaries', () => {
  it('deduplicates relevant and counterevidence passages by source identity', () => {
    const set = structuredClone(labels);
    set.passages.push({ id: 'a-again', path: 'visible/a.md', quote: 'budget is42.' });
    set.judgments.push({
      queryId: 'q',
      passageId: 'a-again',
      role: 'counterevidence',
      review: 'accepted',
      rationale: 'Distinct synthetic passage in the same source.',
    });
    const result = evaluateRetrieval([q], set, observation);
    expect(result.queries[0].recall).toEqual({ found: 1, eligible: 1, ratio: 1 });
    expect(result.queries[0].counterevidence).toEqual({ found: 1, eligible: 1, ratio: 1 });
  });
  it('validates labels before calling a producer and leaves query ownership with the evaluator', () => {
    let called = 0;
    const invalid = structuredClone(labels);
    invalid.judgments[0].queryId = 'unknown';
    expect(() =>
      evaluateRetrieval([q], invalid, () => {
        called++;
        return observation();
      }),
    ).toThrow();
    expect(called).toBe(0);
    const result = evaluateRetrieval([q], labels, (request) => {
      request.id = 'changed';
      request.readPrefixes.push('hidden');
      return observation();
    });
    expect(q.id).toBe('q');
    expect(q.readPrefixes).toEqual(['visible']);
    expect(result.queries[0].queryId).toBe('q');
  });
  it('discloses unjudged hits without inventing precision or a relevance label', () => {
    const result = evaluateRetrieval([q], labels, () => ({
      ...observation(),
      hits: ['visible/a.md', 'visible/b.md'],
    }));
    expect(result.queries[0].unjudgedHits).toEqual(['visible/b.md']);
    expect(result.queries[0]).not.toHaveProperty('precision');
    expect(result.queries[0].answerSupport).toBeNull();
  });
  it('rejects duplicate hit rows and an observation for a different query', () => {
    expect(() =>
      parseRetrievalObservation({ ...observation(), hits: ['visible/a.md', 'visible/a.md'] }, q),
    ).toThrow('Duplicate retrieval entry.');
    expect(() => parseRetrievalObservation({ ...observation(), queryId: 'other' }, q)).toThrow(
      'Retrieval observation identity differs.',
    );
  });
  it('rejects invented cutoff or unavailable data carrying successful results', () => {
    expect(() => parseRetrievalObservation({ ...observation(), effectiveLimit: 50 }, q)).toThrow(
      'Retrieval cutoff does not match the production contract.',
    );
    expect(() => parseRetrievalObservation({ ...observation(), state: 'unavailable' }, q)).toThrow(
      'Unavailable retrieval cannot contain measured results.',
    );
  });
  it('rejects duplicate labels rather than counting them repeatedly', () => {
    const invalid = structuredClone(labels);
    invalid.judgments.push({ ...invalid.judgments[0] });
    expect(() => parseRetrievalLabels(invalid, [q], corpus)).toThrow('Duplicate relevance label.');
  });
});

describe('M97.7 native importer synthetic probes', () => {
  it('accepts a bounded self-consistent probe without claiming it is executed evidence', () => {
    const result = validateRetrievalCapture(capture(), fixtures, identity);
    expect(result.observations[0].observation.costUsd).toBeNull();
    expect(result.limits).toContain(
      'Handwritten synthetic importer probe, not a compiled native capture.',
    );
  });
  it('refuses a stale producer identity and changed compiled fixture bytes', () => {
    const stale = capture();
    stale.nativeInputs.aggregateDigest = 'f'.repeat(64);
    expect(() => validateRetrievalCapture(stale, fixtures, identity)).toThrow(
      'Native retrieval input identity is stale.',
    );
    const changed = capture();
    changed.corpusSha256 = 'f'.repeat(64);
    expect(() => validateRetrievalCapture(changed, fixtures, identity)).toThrow(
      'Native retrieval fixture identity differs.',
    );
  });
  it('refuses missing query coverage or changed source hashes', () => {
    const partial = capture();
    partial.observations = [];
    expect(() => validateRetrievalCapture(partial, fixtures, identity)).toThrow(
      'Native retrieval query coverage is incomplete.',
    );
    const changed = capture();
    changed.sourceFiles[0].sha256 = 'f'.repeat(64);
    expect(() => validateRetrievalCapture(changed, fixtures, identity)).toThrow(
      'Native retrieval source identity differs.',
    );
  });
  it('refuses a wire row mismatch instead of trusting a separately supplied hit list', () => {
    const bad = capture();
    bad.observations[0].wireText = 'No notes matched.';
    expect(() => validateRetrievalCapture(bad, fixtures, identity)).toThrow(
      'Native retrieval wire result differs from its rows.',
    );
  });
  it('refuses filesystem changes even if the retrieval score would look perfect', () => {
    const bad = capture();
    bad.observations[0].sourceAudit.unchanged = false;
    bad.observations[0].sourceAudit.changed = 1;
    expect(() => validateRetrievalCapture(bad, fixtures, identity)).toThrow(
      'Native retrieval fixture changed during observation.',
    );
  });
  it('retains a real leaked hit so the evaluator fails its hard scope gate', () => {
    const leaked = capture();
    leaked.observations[0].observation.hits.push('hidden/c.md');
    leaked.observations[0].wireText = leaked.observations[0].wireText!.replace(
      '1 of 1 note matches',
      '2 of 2 notes match',
    );
    leaked.observations[0].wireText += '\n- hidden/c.md — C';
    const accepted = validateRetrievalCapture(leaked, fixtures, identity);
    const result = evaluateRetrieval([q], labels, () => accepted.observations[0].observation);
    expect(result.status).toBe('failed');
    expect(result.queries[0].hardGates.scopeLeakCount).toBe(1);
  });
  it('refuses fabricated offline model cost and incomplete scope bookkeeping', () => {
    const cost = capture();
    cost.observations[0].observation.costUsd = 0;
    expect(() => validateRetrievalCapture(cost, fixtures, identity)).toThrow(
      'Offline native retrieval did not measure model cost.',
    );
    const scope = capture();
    scope.observations[0].observation.withheldSourceCount = 0;
    expect(() => validateRetrievalCapture(scope, fixtures, identity)).toThrow(
      'Native retrieval scope/cap coverage is incomplete.',
    );
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temporary() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cerebro-retrieval-intake-')));
  roots.push(root);
  return root;
}
describe('M97.7 bounded file intake', () => {
  it('refuses a symlink leaf and invalid UTF8 rather than replacing bytes', () => {
    const root = temporary();
    const source = join(root, 'source.json');
    const link = join(root, 'link.json');
    writeFileSync(source, '{}');
    symlinkSync(source, link);
    expect(() => readRetrievalJson(link, 128)).toThrow();
    expect(readFileSync(source, 'utf8')).toBe('{}');
    const invalid = join(root, 'invalid.json');
    writeFileSync(invalid, Buffer.from([0xff]));
    expect(() => readRetrievalJson(invalid, 128)).toThrow();
  });
  it('rejects over-budget input and preserves the hash of exact accepted bytes', () => {
    const root = temporary();
    const file = join(root, 'input.json');
    const bytes = '{"value":"fixture"}\n';
    writeFileSync(file, bytes);
    expect(() => readRetrievalJson(file, 8)).toThrow();
    const read = readRetrievalJson(file, 128);
    expect(read.value).toEqual({ value: 'fixture' });
    expect(read.sha256).toBe(hash(bytes));
  });
});

// Unexecuted source-review regression probes. Append to the exact formatted
// scripts/outcomes-retrieval-extra.test.ts pinned in probe-manifest.json.
// Uses that file's existing capture/fixtures/identity/labels/corpus/q helpers.
// These are synthetic parser probes, never native execution or baseline evidence.
describe('M97.7 source-review regression boundaries', () => {
  it('refuses unrecognized native text even when the reported hit list is empty', () => {
    const bad = capture();
    bad.observations[0].observation.hits = [];
    bad.observations[0].wireText = 'native result unavailable';
    expect(() => validateRetrievalCapture(bad, fixtures, identity)).toThrow();
  });

  it('refuses conflicting roles for two IDs naming the identical literal passage', () => {
    const bad = structuredClone(labels);
    bad.passages.push({ ...bad.passages[0], id: 'a-alias' });
    bad.judgments.push({
      ...bad.judgments[0],
      passageId: 'a-alias',
      role: 'irrelevant',
    });
    expect(() => parseRetrievalLabels(bad, [q], corpus)).toThrow();
  });
});

describe('M97.7 shared native wire grammar', () => {
  for (const testCase of wireCases.cases)
    it(testCase.name, () => {
      const query: RetrievalQuery = {
        ...q,
        text: testCase.queryText,
        requestedLimit: testCase.requestedLimit,
        readPrefixes: testCase.withheld === 0 ? ['visible', 'hidden'] : ['visible'],
      };
      const corpus = parseRetrievalCorpus(wireCases.corpus);
      const fixtureSet = { ...fixtures, corpus, queries: [query] };
      const raw = capture();
      const observed = raw.observations[0].observation;
      observed.effectiveLimit =
        query.requestedLimit === null ? 20 : Math.min(query.requestedLimit, 100);
      observed.hits = [...testCase.paths];
      observed.admittedPaths = corpus.documents
        .slice(0, corpus.documents.length - testCase.withheld)
        .map((source) => source.path);
      observed.withheldSourceCount = testCase.withheld;
      observed.cappedSourceCount = testCase.capped;
      raw.observations[0].wireText = testCase.wire;
      const read = () => validateRetrievalCapture(raw, fixtureSet, identity);
      if (testCase.valid) {
        const result = read();
        expect(result.observations[0].observation.hits).toEqual(testCase.paths);
        expect(
          evaluateRetrieval([query], labels, () => result.observations[0].observation).queries[0]
            .emptyRetrieval,
        ).toBe(testCase.paths.length === 0);
      } else expect(read).toThrow();
    });
  it('refuses duplicate concrete passages before invoking a producer even when roles agree', () => {
    const duplicate = structuredClone(labels);
    duplicate.passages.push({ ...duplicate.passages[0], id: 'a-alias' });
    duplicate.judgments.push({ ...duplicate.judgments[0], passageId: 'a-alias' });
    let calls = 0;
    expect(() =>
      evaluateRetrieval([q], duplicate, () => {
        calls++;
        return observation();
      }),
    ).toThrow('Duplicate concrete label passage.');
    expect(calls).toBe(0);
  });
});
