/** Offline retrieval evaluation. Expected labels never reach the native producer. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import format from '../../conformance/retrieval/format.v1.json';
import {
  nativeInputIdentity,
  NATIVE_INPUT_LIMITS,
  type NativeInputIdentity,
} from './native-inputs';

export interface RetrievalQuery {
  id: string;
  kind: string;
  text: string;
  readPrefixes: string[];
  requestedLimit: number | null;
}
export interface RetrievalCorpus {
  version: 1;
  provenance: { synthetic: true; author: string; note: string };
  documents: { path: string; markdown: string }[];
}
export interface RetrievalLabels {
  version: 1;
  provenance: { author: string; basis: string };
  passages: { id: string; path: string; quote: string }[];
  judgments: {
    queryId: string;
    passageId: string;
    role: 'supporting' | 'counterevidence' | 'irrelevant';
    review: 'proposed' | 'accepted' | 'disputed';
    rationale: string;
  }[];
}
export interface RetrievalObservation {
  queryId: string;
  state: 'ready' | 'unavailable';
  effectiveLimit: number | null;
  hits: string[];
  admittedPaths: string[];
  durationMs: number | null;
  costUsd: number | null;
  cappedSourceCount: number | null;
  withheldSourceCount: number | null;
  limitations: string[];
}
export interface RetrievalCoverage {
  found: number;
  eligible: number;
  ratio: number | null;
}
export interface RetrievalQueryReport {
  queryId: string;
  status: 'passed' | 'failed' | 'unavailable' | 'provisional';
  effectiveLimit: number | null;
  recall: RetrievalCoverage | null;
  counterevidence: RetrievalCoverage | null;
  emptyRetrieval: boolean | null;
  durationMs: number | null;
  costUsd: number | null;
  excludedLabels: { proposed: number; disputed: number; outsideScope: number };
  hardGates: { scopeLeakCount: number };
  answerSupport: null;
  modelAbstention: null;
  unjudgedHits: string[];
  cappedSourceCount: number | null;
  withheldSourceCount: number | null;
  coverageReasons: {
    recall: string | null;
    counterevidence: string | null;
    passage: string;
    model: string;
  };
  limitations: string[];
}
export interface RetrievalReport {
  status: RetrievalQueryReport['status'];
  queries: RetrievalQueryReport[];
  usage: { costUsd: number | null; unrecordedCostQueries: number };
}
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const L = format.limits;
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
function object(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Expected a retrieval object.');
  return raw as Record<string, unknown>;
}
function exact(raw: Record<string, unknown>, fields: readonly string[]) {
  if (
    Object.keys(raw).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(raw, field))
  )
    throw new Error('Unexpected retrieval fields.');
}
function text(raw: unknown, cap: number, empty = false): string {
  if (
    typeof raw !== 'string' ||
    (!empty && raw.length === 0) ||
    raw.includes('\0') ||
    Buffer.byteLength(raw) > cap ||
    [...raw].some((ch) => {
      const n = ch.codePointAt(0)!;
      return n >= 0xd800 && n <= 0xdfff;
    })
  )
    throw new Error('Invalid bounded retrieval text.');
  return raw;
}
function rows(raw: unknown, cap: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > cap) throw new Error('Retrieval array cap exceeded.');
  return raw;
}
function id(raw: unknown): string {
  const value = text(raw, 64);
  if (!/^[a-z][a-z0-9-]*$/.test(value)) throw new Error('Invalid retrieval identity.');
  return value;
}
function integer(raw: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < min || (raw as number) > max)
    throw new Error('Invalid retrieval count.');
  return raw as number;
}
function measurement(raw: unknown): number | null {
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > Number.MAX_SAFE_INTEGER)
    throw new Error('Invalid retrieval measurement.');
  return raw;
}
function safePath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || Buffer.byteLength(raw) > L.pathBytes)
    throw new Error('Unsafe retrieval fixture path.');
  const parts = raw.split('/');
  const forbidden = new Set(['credentials', 'id_rsa', 'id_ed25519', 'token', 'tokens', 'secrets']);
  if (
    parts.length > L.pathDepth ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(part) ||
        forbidden.has(part.toLowerCase()) ||
        /\.(key|pem)$/i.test(part),
    )
  )
    throw new Error('Unsafe retrieval fixture path.');
  return raw;
}
function unique(values: readonly string[], message: string) {
  if (new Set(values).size !== values.length) throw new Error(message);
}
function strings(raw: unknown, cap: number, read: (value: unknown) => string): string[] {
  const values = rows(raw, cap).map(read);
  unique(values, 'Duplicate retrieval entry.');
  return values;
}
function checkFormat() {
  exact(format, [
    'version',
    'producer',
    'scenario',
    'clock',
    'surface',
    'defaultCutoff',
    'maximumCutoff',
    'limits',
    'queryKinds',
    'blankQueryScalars',
  ]);
  exact(L, [
    'queries',
    'documents',
    'documentBytes',
    'corpusBytes',
    'queryBytes',
    'passages',
    'judgments',
    'quoteScalars',
    'pathBytes',
    'pathDepth',
    'toolResultBytes',
    'captureBytes',
    'fixtureJsonBytes',
    'treeEntries',
  ]);
  if (
    format.version !== 1 ||
    format.producer !== 'mcp::search_notes_in' ||
    format.scenario !== 'retrieval' ||
    format.surface !== 'assistant_scoped_search_notes' ||
    format.clock !== 'native_monotonic_per_query'
  )
    throw new Error('Unsupported retrieval format.');
  for (const value of Object.values(L)) integer(value, 1, 4 * 1024 * 1024);
  integer(format.defaultCutoff, 1, format.maximumCutoff);
  integer(format.maximumCutoff, 1, L.documents);
  unique(format.queryKinds, 'Duplicate retrieval query kind.');
  if (
    format.blankQueryScalars.length === 0 ||
    format.blankQueryScalars.length > 256 ||
    format.blankQueryScalars.some(
      (value, index) =>
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 0x10ffff ||
        (value >= 0xd800 && value <= 0xdfff) ||
        (index > 0 && value <= format.blankQueryScalars[index - 1]),
    )
  )
    throw new Error('Invalid retrieval blank-query vocabulary.');
}
checkFormat();

export function parseRetrievalCorpus(raw: unknown): RetrievalCorpus {
  const value = object(raw);
  exact(value, ['version', 'provenance', 'documents']);
  if (value.version !== 1) throw new Error('Unsupported retrieval corpus.');
  const provenance = object(value.provenance);
  exact(provenance, ['synthetic', 'author', 'note']);
  if (provenance.synthetic !== true)
    throw new Error('Only synthetic retrieval fixtures are accepted.');
  let bytes = 0;
  const documents = rows(value.documents, L.documents).map((item) => {
    const row = object(item);
    exact(row, ['path', 'markdown']);
    const path = safePath(row.path);
    if (!path.endsWith('.md')) throw new Error('Retrieval fixtures must be Markdown.');
    const markdown = text(row.markdown, L.documentBytes, true);
    bytes += Buffer.byteLength(markdown);
    if (bytes > L.corpusBytes) throw new Error('Retrieval corpus byte cap exceeded.');
    return { path, markdown };
  });
  if (documents.length === 0) throw new Error('Retrieval corpus is empty.');
  unique(
    documents.map((row) => row.path.toLowerCase()),
    'Duplicate retrieval source path.',
  );
  const paths = new Set(documents.map((row) => row.path.toLowerCase()));
  for (const row of documents) {
    const parts = row.path.toLowerCase().split('/');
    for (let n = 1; n < parts.length; n++)
      if (paths.has(parts.slice(0, n).join('/')))
        throw new Error('Retrieval source path is also a directory.');
  }
  return {
    version: 1,
    provenance: {
      synthetic: true,
      author: text(provenance.author, 256),
      note: text(provenance.note, 4096),
    },
    documents,
  };
}

export function parseRetrievalQueries(raw: unknown): RetrievalQuery[] {
  const value = object(raw);
  exact(value, ['version', 'queries']);
  if (value.version !== 1) throw new Error('Unsupported retrieval queries.');
  const queries = rows(value.queries, L.queries).map((item) => {
    const row = object(item);
    exact(row, ['id', 'kind', 'text', 'readPrefixes', 'requestedLimit']);
    const kind = id(row.kind);
    if (!format.queryKinds.includes(kind)) throw new Error('Unknown retrieval query kind.');
    const queryText = text(row.text, L.queryBytes);
    if (
      [...queryText].every((character) =>
        format.blankQueryScalars.includes(character.codePointAt(0)!),
      )
    )
      throw new Error('Retrieval query is blank.');
    return {
      id: id(row.id),
      kind,
      text: queryText,
      readPrefixes: strings(row.readPrefixes, L.documents, safePath),
      requestedLimit: row.requestedLimit === null ? null : integer(row.requestedLimit, 1, 10000),
    };
  });
  if (queries.length === 0) throw new Error('Retrieval queries are empty.');
  unique(
    queries.map((row) => row.id),
    'Duplicate retrieval query identity.',
  );
  return queries;
}

function labelShape(raw: unknown, queries: readonly RetrievalQuery[]): RetrievalLabels {
  const value = object(raw);
  exact(value, ['version', 'provenance', 'passages', 'judgments']);
  if (value.version !== 1) throw new Error('Unsupported retrieval labels.');
  const provenance = object(value.provenance);
  exact(provenance, ['author', 'basis']);
  const passages = rows(value.passages, L.passages).map((item) => {
    const row = object(item);
    exact(row, ['id', 'path', 'quote']);
    const quote = text(row.quote, L.quoteScalars * 4);
    if ([...quote].length > L.quoteScalars) throw new Error('Label quote scalar cap exceeded.');
    return { id: id(row.id), path: safePath(row.path), quote };
  });
  unique(
    passages.map((row) => row.id),
    'Duplicate label passage identity.',
  );
  unique(
    passages.map((row) => row.path + '\0' + row.quote),
    'Duplicate concrete label passage.',
  );
  const queryIds = new Set(queries.map((query) => query.id));
  const passageIds = new Set(passages.map((passage) => passage.id));
  const judgments = rows(value.judgments, L.judgments).map(
    (item): RetrievalLabels['judgments'][number] => {
      const row = object(item);
      exact(row, ['queryId', 'passageId', 'role', 'review', 'rationale']);
      const queryId = id(row.queryId);
      const passageId = id(row.passageId);
      if (!queryIds.has(queryId) || !passageIds.has(passageId))
        throw new Error('Unknown label query or passage.');
      if (row.role !== 'supporting' && row.role !== 'counterevidence' && row.role !== 'irrelevant')
        throw new Error('Unknown relevance role.');
      if (row.review !== 'proposed' && row.review !== 'accepted' && row.review !== 'disputed')
        throw new Error('Unknown label review state.');
      return {
        queryId,
        passageId,
        role: row.role,
        review: row.review,
        rationale: text(row.rationale, 4096),
      };
    },
  );
  const seen = new Map<string, string>();
  for (const row of judgments) {
    const key = row.queryId + '\0' + row.passageId;
    if (seen.has(key))
      throw new Error(
        seen.get(key) !== row.role ? 'Conflicting relevance labels.' : 'Duplicate relevance label.',
      );
    seen.set(key, row.role);
  }
  return {
    version: 1,
    provenance: { author: text(provenance.author, 256), basis: text(provenance.basis, 4096) },
    passages,
    judgments,
  };
}
export function parseRetrievalLabels(
  raw: unknown,
  queries: readonly RetrievalQuery[],
  corpus: RetrievalCorpus,
): RetrievalLabels {
  const checkedQueries = parseRetrievalQueries({ version: 1, queries });
  const checkedCorpus = parseRetrievalCorpus(corpus);
  const labels = labelShape(raw, checkedQueries);
  const sources = new Map(checkedCorpus.documents.map((row) => [row.path, row.markdown]));
  for (const passage of labels.passages) {
    const source = sources.get(passage.path);
    const first = source?.indexOf(passage.quote) ?? -1;
    if (source === undefined || first < 0 || source.indexOf(passage.quote, first + 1) !== -1)
      throw new Error('Label passage is not unique in its source.');
  }
  return labels;
}

export function parseRetrievalObservation(
  raw: unknown,
  query: RetrievalQuery,
): RetrievalObservation {
  const row = object(raw);
  exact(row, [
    'queryId',
    'state',
    'effectiveLimit',
    'hits',
    'admittedPaths',
    'durationMs',
    'costUsd',
    'cappedSourceCount',
    'withheldSourceCount',
    'limitations',
  ]);
  if (row.queryId !== query.id || (row.state !== 'ready' && row.state !== 'unavailable'))
    throw new Error('Retrieval observation identity differs.');
  const hits = strings(row.hits, L.documents, safePath);
  const admittedPaths = strings(row.admittedPaths, L.documents, safePath);
  const effectiveLimit =
    row.effectiveLimit === null ? null : integer(row.effectiveLimit, 1, format.maximumCutoff);
  const cappedSourceCount =
    row.cappedSourceCount === null ? null : integer(row.cappedSourceCount, 0, L.documents);
  const withheldSourceCount =
    row.withheldSourceCount === null ? null : integer(row.withheldSourceCount, 0, L.documents);
  if (row.state === 'ready') {
    const expected =
      query.requestedLimit === null
        ? format.defaultCutoff
        : Math.min(query.requestedLimit, format.maximumCutoff);
    if (effectiveLimit === null || effectiveLimit !== expected)
      throw new Error('Retrieval cutoff does not match the production contract.');
    if (hits.length > effectiveLimit)
      throw new Error('Retrieval observation exceeds its recorded cutoff.');
  } else if (
    effectiveLimit !== null ||
    hits.length !== 0 ||
    admittedPaths.length !== 0 ||
    cappedSourceCount !== null ||
    withheldSourceCount !== null
  )
    throw new Error('Unavailable retrieval cannot contain measured results.');
  return {
    queryId: query.id,
    state: row.state,
    effectiveLimit,
    hits,
    admittedPaths,
    durationMs: measurement(row.durationMs),
    costUsd: measurement(row.costUsd),
    cappedSourceCount,
    withheldSourceCount,
    limitations: strings(row.limitations, 32, (value) => text(value, 4096)),
  };
}
function coverage(sources: Set<string>, hits: Set<string>): RetrievalCoverage | null {
  if (sources.size === 0) return null;
  const found = [...sources].filter((source) => hits.has(source)).length;
  return { found, eligible: sources.size, ratio: found / sources.size };
}
export function evaluateRetrieval(
  queries: readonly RetrievalQuery[],
  labels: RetrievalLabels,
  productionRetriever: (query: RetrievalQuery) => RetrievalObservation,
): RetrievalReport {
  const checkedQueries = parseRetrievalQueries({ version: 1, queries });
  // This public evaluator validates its own structural boundary. The file loader
  // separately checks quotes against the corpus before a real baseline is scored.
  const checkedLabels = labelShape(labels, checkedQueries);
  const passages = new Map(checkedLabels.passages.map((passage) => [passage.id, passage]));
  const reports: RetrievalQueryReport[] = checkedQueries.map((query) => {
    const observation = parseRetrievalObservation(
      productionRetriever({ ...query, readPrefixes: [...query.readPrefixes] }),
      query,
    );
    const admitted = new Set(observation.admittedPaths);
    const hits = new Set(observation.hits);
    const relevant = new Set<string>();
    const counter = new Set<string>();
    const judged = new Set<string>();
    const excludedLabels = { proposed: 0, disputed: 0, outsideScope: 0 };
    for (const label of checkedLabels.judgments.filter((label) => label.queryId === query.id)) {
      if (label.review !== 'accepted') {
        excludedLabels[label.review]++;
        continue;
      }
      if (observation.state === 'unavailable') continue;
      const source = passages.get(label.passageId)!.path;
      if (!admitted.has(source)) {
        excludedLabels.outsideScope++;
        continue;
      }
      judged.add(source);
      if (label.role !== 'irrelevant') relevant.add(source);
      if (label.role === 'counterevidence') counter.add(source);
    }
    const scopeLeakCount = observation.hits.filter((source) => !admitted.has(source)).length;
    const ready = observation.state === 'ready';
    const pending = excludedLabels.proposed + excludedLabels.disputed;
    const recall = ready ? coverage(relevant, hits) : null;
    const counterevidence = ready ? coverage(counter, hits) : null;
    const status =
      scopeLeakCount > 0
        ? 'failed'
        : !ready
          ? 'unavailable'
          : relevant.size === 0 && pending > 0
            ? 'provisional'
            : 'passed';
    return {
      queryId: query.id,
      status,
      effectiveLimit: observation.effectiveLimit,
      recall,
      counterevidence,
      emptyRetrieval: ready ? hits.size === 0 : null,
      durationMs: observation.durationMs,
      costUsd: observation.costUsd,
      excludedLabels,
      hardGates: { scopeLeakCount },
      answerSupport: null,
      modelAbstention: null,
      unjudgedHits: ready
        ? observation.hits.filter((source) => admitted.has(source) && !judged.has(source))
        : [],
      cappedSourceCount: observation.cappedSourceCount,
      withheldSourceCount: observation.withheldSourceCount,
      coverageReasons: {
        recall:
          recall !== null
            ? null
            : !ready
              ? 'Corpus observation unavailable.'
              : pending > 0
                ? 'No accepted in-scope relevance denominator; proposed/disputed labels are excluded.'
                : 'No accepted in-scope relevant sources; source recall is not applicable.',
        counterevidence:
          counterevidence !== null
            ? null
            : !ready
              ? 'Corpus observation unavailable.'
              : 'No accepted in-scope counterevidence denominator.',
        passage: 'Path retrieval does not establish exact passage display, reading or citation.',
        model: 'No model answer, support judgment or model abstention was observed.',
      },
      limitations: observation.limitations,
    };
  });
  const status = reports.some((report) => report.status === 'failed')
    ? 'failed'
    : reports.some((report) => report.status === 'unavailable')
      ? 'unavailable'
      : reports.some((report) => report.status === 'provisional')
        ? 'provisional'
        : 'passed';
  const unrecordedCostQueries = reports.filter((report) => report.costUsd === null).length;
  const sum = reports.reduce((value, report) => value + (report.costUsd ?? 0), 0);
  if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER)
    throw new Error('Retrieval cost total exceeds its bound.');
  return {
    status,
    queries: reports,
    usage: { costUsd: unrecordedCostQueries > 0 ? null : sum, unrecordedCostQueries },
  };
}

export interface RetrievalFixtures {
  corpus: RetrievalCorpus;
  queries: RetrievalQuery[];
  labels: RetrievalLabels;
  digests: { corpus: string; queries: string; labels: string; format: string };
}
export interface RetrievalNativeCapture {
  version: 1;
  scenario: string;
  producer: string;
  observedAt: string;
  clock: string;
  nativeInputs: NativeInputIdentity;
  corpusSha256: string;
  queriesSha256: string;
  formatSha256: string;
  sourceFiles: { path: string; bytes: number; sha256: string }[];
  observations: {
    observation: RetrievalObservation;
    wireText: string | null;
    errorCode: string | null;
    sourceAudit: {
      verifiedBefore: number;
      verifiedAfter: number;
      missing: number;
      changed: number;
      additional: number;
      symlinks: number;
      unchanged: boolean;
    };
  }[];
  limits: string[];
}
/** Retrieval has a larger bounded body fixture than the ordinary outcome reader.
 * This reader leaves that reader's 16KiB string limit unchanged. */
export function readRetrievalJson(file: string, cap: number): { value: unknown; sha256: string } {
  integer(cap, 1, L.fixtureJsonBytes);
  const absolute = resolve(file);
  if (realpathSync(dirname(absolute)) !== dirname(absolute))
    throw new Error('Retrieval input parent must be canonical.');
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(cap))
      throw new Error('Retrieval input must be a bounded regular file.');
    const buffer = Buffer.alloc(cap + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > cap) throw new Error('Retrieval input grew beyond its cap.');
    const after = fstatSync(fd, { bigint: true });
    const current = lstatSync(absolute, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== current.dev ||
      after.ino !== current.ino ||
      after.size !== current.size ||
      after.mtimeNs !== current.mtimeNs ||
      after.ctimeNs !== current.ctimeNs ||
      BigInt(length) !== after.size
    )
      throw new Error('Retrieval input changed while reading.');
    bytes = buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const pending = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const next = pending.pop()!;
    if (++visited > 50000 || next.depth > 16)
      throw new Error('Retrieval JSON structure exceeds its cap.');
    if (next.value !== null && typeof next.value === 'object')
      for (const child of Object.values(next.value))
        pending.push({ value: child, depth: next.depth + 1 });
  }
  return { value, sha256: digest(bytes) };
}
export function loadRetrievalFixtures(repositoryRoot = ROOT): RetrievalFixtures {
  const repository = realpathSync(resolve(repositoryRoot));
  const directory = join(repository, 'conformance', 'retrieval');
  if (realpathSync(directory) !== directory)
    throw new Error('Retrieval fixture directory must be canonical.');
  const loadedFormat = readRetrievalJson(join(directory, 'format.v1.json'), 16384);
  if (JSON.stringify(loadedFormat.value) !== JSON.stringify(format))
    throw new Error('Retrieval contract changed after module load.');
  const corpusInput = readRetrievalJson(join(directory, 'corpus.v1.json'), L.fixtureJsonBytes);
  const queryInput = readRetrievalJson(join(directory, 'queries.json'), L.fixtureJsonBytes);
  const labelInput = readRetrievalJson(join(directory, 'labels.json'), L.fixtureJsonBytes);
  const corpus = parseRetrievalCorpus(corpusInput.value);
  const queries = parseRetrievalQueries(queryInput.value);
  const labels = parseRetrievalLabels(labelInput.value, queries, corpus);
  return {
    corpus,
    queries,
    labels,
    digests: {
      corpus: corpusInput.sha256,
      queries: queryInput.sha256,
      labels: labelInput.sha256,
      format: loadedFormat.sha256,
    },
  };
}
function hashText(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw))
    throw new Error('Invalid retrieval digest.');
  return raw;
}
function inputIdentity(raw: unknown): NativeInputIdentity {
  const row = object(raw);
  exact(row, ['version', 'aggregateDigest', 'fileCount', 'totalBytes']);
  if (row.version !== 1) throw new Error('Invalid retrieval producer input version.');
  return {
    version: 1,
    aggregateDigest: hashText(row.aggregateDigest),
    fileCount: integer(row.fileCount, 1, NATIVE_INPUT_LIMITS.files),
    totalBytes: integer(row.totalBytes, 0, NATIVE_INPUT_LIMITS.totalBytes),
  };
}
/** Recognize the current untyped/all-fields fixture producer, never guessed emptiness.
 * Unknown query/read-error footers are refused rather than silently dropped. */
function wirePaths(
  wire: string,
  query: RetrievalQuery,
  withheld: number | null,
  capped: number | null,
): string[] {
  if (withheld === null || capped === null)
    throw new Error('Native retrieval scope/cap coverage is incomplete.');
  const refused = () => new Error('Native retrieval wire result differs from its rows.');
  const scopeNote =
    withheld === 0
      ? ''
      : ' (' + withheld + " notes outside this run's read scope were not searched)";
  const capNote =
    capped === 0
      ? ''
      : ' (' +
        capped +
        (capped === 1
          ? ' note longer than 100 KB was searched in its first 100 KB)'
          : ' notes longer than 100 KB were searched in their first 100 KB)');
  const limitFooter =
    query.requestedLimit !== null && query.requestedLimit > format.maximumCutoff
      ? ['The limit is at most 100.']
      : [];
  const empty =
    'No notes matched "' +
    query.text +
    '".' +
    scopeNote +
    capNote +
    (limitFooter.length === 0 ? '' : '\n\n' + limitFooter.join('\n'));
  if (wire === empty) return [];
  const widenedPrefix = 'No note contains every word of "' + query.text + '". ';
  const widened = wire.startsWith(widenedPrefix);
  const counts = /^([1-9][0-9]*) of ([1-9][0-9]*) /.exec(
    widened ? wire.slice(widenedPrefix.length) : wire,
  );
  if (counts === null) throw refused();
  const shown = Number(counts[1]);
  const total = Number(counts[2]);
  const cutoff =
    query.requestedLimit === null
      ? format.defaultCutoff
      : Math.min(query.requestedLimit, format.maximumCutoff);
  if (
    !Number.isSafeInteger(shown) ||
    !Number.isSafeInteger(total) ||
    shown > cutoff ||
    total < shown ||
    total > L.documents
  )
    throw refused();
  const header = widened
    ? widenedPrefix +
      shown +
      ' of ' +
      total +
      ' closest ' +
      (total === 1 ? 'match' : 'matches') +
      ', best first' +
      scopeNote +
      capNote +
      ':'
    : shown +
      ' of ' +
      total +
      (total === 1 ? ' note matches "' : ' notes match "') +
      query.text +
      '", best first' +
      scopeNote +
      capNote +
      ':';
  if (!wire.startsWith(header + '\n')) throw refused();
  let body = wire.slice(header.length + 1);
  const footers = [
    ...(total > shown
      ? [total - shown + ' more not shown; raise limit (at most 100) or narrow the query.']
      : []),
    ...limitFooter,
  ];
  if (footers.length > 0) {
    const suffix = '\n\n' + footers.join('\n');
    if (!body.endsWith(suffix)) throw refused();
    body = body.slice(0, -suffix.length);
  }
  const paths: string[] = [];
  let detailLines = 0;
  let matched = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('- ')) {
      if (widened && paths.length > 0 && !matched) throw refused();
      const marker = line.indexOf(' — ', 2);
      if (marker === -1 || line.slice(marker + 3).length === 0) throw refused();
      paths.push(safePath(line.slice(2, marker)));
      detailLines = 0;
      matched = false;
    } else {
      if (paths.length === 0 || !line.startsWith('  ') || line.length === 2 || matched)
        throw refused();
      if (widened && line.startsWith('  matched: ') && line.length > '  matched: '.length)
        matched = true;
      else if (++detailLines > 1) throw refused();
    }
  }
  if (paths.length !== shown || new Set(paths).size !== paths.length || (widened && !matched))
    throw refused();
  return paths;
}
/** Pure importer validation. Unit callers supply synthetic expected identities.
 * The real file reader below derives the current identity itself. */
export function validateRetrievalCapture(
  raw: unknown,
  fixtures: RetrievalFixtures,
  currentInputs: NativeInputIdentity,
): RetrievalNativeCapture {
  const row = object(raw);
  exact(row, [
    'version',
    'scenario',
    'producer',
    'observedAt',
    'clock',
    'nativeInputs',
    'corpusSha256',
    'queriesSha256',
    'formatSha256',
    'sourceFiles',
    'observations',
    'limits',
  ]);
  if (
    row.version !== 1 ||
    row.scenario !== format.scenario ||
    row.producer !== format.producer ||
    row.clock !== format.clock ||
    !Number.isFinite(Date.parse(text(row.observedAt, 128)))
  )
    throw new Error('Invalid retrieval producer identity.');
  const nativeInputs = inputIdentity(row.nativeInputs);
  const expectedInputs = inputIdentity(currentInputs);
  if (
    nativeInputs.aggregateDigest !== expectedInputs.aggregateDigest ||
    nativeInputs.fileCount !== expectedInputs.fileCount ||
    nativeInputs.totalBytes !== expectedInputs.totalBytes
  )
    throw new Error('Native retrieval input identity is stale.');
  if (
    hashText(row.corpusSha256) !== fixtures.digests.corpus ||
    hashText(row.queriesSha256) !== fixtures.digests.queries ||
    hashText(row.formatSha256) !== fixtures.digests.format
  )
    throw new Error('Native retrieval fixture identity differs.');
  const corpus = parseRetrievalCorpus(fixtures.corpus);
  const queries = parseRetrievalQueries({ version: 1, queries: fixtures.queries });
  const expectedFiles = new Map(
    corpus.documents.map((document) => [
      document.path,
      { bytes: Buffer.byteLength(document.markdown), sha256: digest(document.markdown) },
    ]),
  );
  const sourceFiles = rows(row.sourceFiles, L.documents).map((value) => {
    const source = object(value);
    exact(source, ['path', 'bytes', 'sha256']);
    const path = safePath(source.path);
    const bytes = integer(source.bytes, 0, L.documentBytes);
    const sha256 = hashText(source.sha256);
    const expected = expectedFiles.get(path);
    if (expected === undefined || expected.bytes !== bytes || expected.sha256 !== sha256)
      throw new Error('Native retrieval source identity differs.');
    return { path, bytes, sha256 };
  });
  unique(
    sourceFiles.map((source) => source.path),
    'Duplicate native retrieval source.',
  );
  if (sourceFiles.length !== expectedFiles.size)
    throw new Error('Native retrieval sources are incomplete.');
  const values = rows(row.observations, L.queries);
  if (values.length !== queries.length)
    throw new Error('Native retrieval query coverage is incomplete.');
  const observations = values.map((value, index) => {
    const entry = object(value);
    exact(entry, ['observation', 'wireText', 'errorCode', 'sourceAudit']);
    const observation = parseRetrievalObservation(entry.observation, queries[index]);
    if (
      [...observation.hits, ...observation.admittedPaths].some((path) => !expectedFiles.has(path))
    )
      throw new Error('Native retrieval returned an unknown source.');
    const source = object(entry.sourceAudit);
    exact(source, [
      'verifiedBefore',
      'verifiedAfter',
      'missing',
      'changed',
      'additional',
      'symlinks',
      'unchanged',
    ]);
    const sourceAudit = {
      verifiedBefore: integer(source.verifiedBefore, 0, L.documents),
      verifiedAfter: integer(source.verifiedAfter, 0, L.documents),
      missing: integer(source.missing, 0, L.documents),
      changed: integer(source.changed, 0, L.documents),
      additional: integer(source.additional, 0, L.treeEntries),
      symlinks: integer(source.symlinks, 0, L.treeEntries),
      unchanged: source.unchanged === true,
    };
    if (
      !sourceAudit.unchanged ||
      sourceAudit.verifiedBefore !== expectedFiles.size ||
      sourceAudit.verifiedAfter !== expectedFiles.size ||
      sourceAudit.missing !== 0 ||
      sourceAudit.changed !== 0 ||
      sourceAudit.additional !== 0 ||
      sourceAudit.symlinks !== 0
    )
      throw new Error('Native retrieval fixture changed during observation.');
    let wireText: string | null;
    let errorCode: string | null;
    if (observation.state === 'ready') {
      wireText = text(entry.wireText, L.toolResultBytes);
      errorCode = null;
      if (
        observation.withheldSourceCount === null ||
        observation.cappedSourceCount === null ||
        observation.withheldSourceCount + observation.admittedPaths.length !== expectedFiles.size ||
        observation.cappedSourceCount > observation.admittedPaths.length
      )
        throw new Error('Native retrieval scope/cap coverage is incomplete.');
      if (
        entry.errorCode !== null ||
        JSON.stringify(
          wirePaths(
            wireText,
            queries[index],
            observation.withheldSourceCount,
            observation.cappedSourceCount,
          ),
        ) !== JSON.stringify(observation.hits)
      )
        throw new Error('Native retrieval wire result differs from its rows.');
    } else {
      wireText = null;
      errorCode = 'corpus_unavailable';
      if (entry.wireText !== null || entry.errorCode !== errorCode)
        throw new Error('Invalid unavailable retrieval evidence.');
    }
    if (observation.costUsd !== null)
      throw new Error('Offline native retrieval did not measure model cost.');
    return { observation, wireText, errorCode, sourceAudit };
  });
  return {
    version: 1,
    scenario: format.scenario,
    producer: format.producer,
    observedAt: text(row.observedAt, 128),
    clock: format.clock,
    nativeInputs,
    corpusSha256: fixtures.digests.corpus,
    queriesSha256: fixtures.digests.queries,
    formatSha256: fixtures.digests.format,
    sourceFiles,
    observations,
    limits: strings(row.limits, 32, (value) => text(value, 4096)),
  };
}
export function readRetrievalCapture(
  file: string,
  fixtures: RetrievalFixtures,
  repositoryRoot = ROOT,
): RetrievalNativeCapture {
  const raw = readRetrievalJson(file, L.captureBytes).value;
  return validateRetrievalCapture(raw, fixtures, nativeInputIdentity(repositoryRoot));
}
function argumentsOf(args: string[]): { out: string; nativeReport?: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !['--mode', '--out', '--native-report'].includes(key) ||
      values.has(key) ||
      value === undefined ||
      value.length === 0 ||
      value.startsWith('--')
    )
      throw new Error('Invalid retrieval arguments.');
    values.set(key, value);
  }
  if (values.get('--mode') !== 'offline' || !values.has('--out'))
    throw new Error('Offline mode and output are required.');
  return {
    out: resolve(values.get('--out')!),
    ...(values.has('--native-report')
      ? { nativeReport: resolve(values.get('--native-report')!) }
      : {}),
  };
}
/** Runs no native process, model, provider, CLI or network operation. */
export function runRetrievalCli(args: string[]): number {
  try {
    const options = argumentsOf(args);
    const fixtures = loadRetrievalFixtures();
    const capture =
      options.nativeReport === undefined
        ? null
        : readRetrievalCapture(options.nativeReport, fixtures);
    const observations = new Map(
      capture?.observations.map((entry) => [entry.observation.queryId, entry.observation]) ?? [],
    );
    const report = evaluateRetrieval(
      fixtures.queries,
      fixtures.labels,
      (query) =>
        observations.get(query.id) ?? {
          queryId: query.id,
          state: 'unavailable',
          effectiveLimit: null,
          hits: [],
          admittedPaths: [],
          durationMs: null,
          costUsd: null,
          cappedSourceCount: null,
          withheldSourceCount: null,
          limitations: ['An actual current native retrieval capture was not supplied.'],
        },
    );
    const output = {
      version: 1,
      ...report,
      fixtureDigests: fixtures.digests,
      producer:
        capture === null
          ? null
          : {
              producer: capture.producer,
              observedAt: capture.observedAt,
              clock: capture.clock,
              nativeInputs: capture.nativeInputs,
            },
      limitations: [
        'Fixture gate status is not a retrieval quality threshold.',
        'Source recall only; exact passage coverage and model support/abstention were not measured.',
        'Proposed/disputed labels are excluded and disclosed.',
        ...(capture?.limits ?? []),
      ],
    };
    const bytes = JSON.stringify(output, null, 2) + '\n';
    if (Buffer.byteLength(bytes) > L.captureBytes)
      throw new Error('Retrieval report exceeds its cap.');
    // Evaluate and validate all inputs before creating output. Invalid evidence
    // cannot leave a report that looks like a successfully measured empty run.
    const parent = realpathSync(dirname(options.out));
    if (parent !== dirname(options.out))
      throw new Error('Retrieval output parent must be canonical.');
    try {
      const stat = lstatSync(options.out);
      if (!stat.isDirectory() || stat.isSymbolicLink() || readdirSync(options.out).length !== 0)
        throw new Error('Retrieval output must be new or empty.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(options.out, { mode: 0o700 });
    }
    writeFileSync(join(options.out, 'report.json'), bytes, { flag: 'wx', mode: 0o600 });
    return report.status === 'failed'
      ? 1
      : report.status === 'unavailable' || report.status === 'provisional'
        ? 3
        : 0;
  } catch {
    return 2;
  }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = runRetrievalCli(process.argv.slice(2));
  if (code === 2)
    process.stderr.write('Retrieval evaluation refused input or could not produce its report.\n');
  process.exitCode = code;
}
