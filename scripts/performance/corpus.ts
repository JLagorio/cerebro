import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export type BenchmarkCase = {
  id: string;
  kind: 'table' | 'document' | 'transcript' | 'search';
  seed: number;
  count: number;
  fields: number;
  shape: 'short' | 'long' | 'sparse' | 'wrapped' | 'relations';
  documentBytes: number;
};
export type Corpus = {
  files: { path: string; content: string }[];
  conversation: object | null;
  manifest: {
    seed: number;
    files: number;
    bytes: number;
    conversationBytes: number;
    sha256: string;
  };
};

/** These are generated fixtures, not a sampling of somebody's vault. */
export function reliabilityMatrix(seed = 93): BenchmarkCase[] {
  const tables = [100, 1000, 5000].flatMap((count) =>
    [12, 24].map((fields): BenchmarkCase => ({
      id: `table-${count}x${fields}`,
      kind: 'table',
      seed,
      count,
      fields,
      shape: 'short',
      documentBytes: 0,
    })),
  );
  return [
    ...tables,
    ...(['long', 'sparse', 'wrapped', 'relations'] as const).map((shape): BenchmarkCase => ({
      id: `table-1000x12-${shape}`,
      kind: 'table',
      seed,
      count: 1000,
      fields: 12,
      shape,
      documentBytes: 0,
    })),
    ...[65536, 262144].map((documentBytes): BenchmarkCase => ({
      id: `document-${documentBytes / 1024}k`,
      kind: 'document',
      seed,
      count: 1,
      fields: 0,
      shape: 'long',
      documentBytes,
    })),
    {
      id: 'transcript-1000',
      kind: 'transcript',
      seed,
      count: 1000,
      fields: 0,
      shape: 'long',
      documentBytes: 0,
    },
    {
      id: 'search-10000',
      kind: 'search',
      seed,
      count: 10000,
      fields: 0,
      shape: 'short',
      documentBytes: 0,
    },
  ];
}

function checkCase(fixture: BenchmarkCase) {
  if (
    !Number.isSafeInteger(fixture.seed) ||
    fixture.seed < 0 ||
    fixture.seed > 0xffffffff ||
    !Number.isInteger(fixture.count) ||
    fixture.count < 1 ||
    fixture.count > 10000 ||
    !Number.isInteger(fixture.fields) ||
    fixture.fields < 0 ||
    fixture.fields > 24 ||
    !Number.isInteger(fixture.documentBytes) ||
    fixture.documentBytes < 0 ||
    fixture.documentBytes > 1024 * 1024 ||
    (fixture.kind === 'document' && fixture.documentBytes < 256) ||
    (fixture.kind === 'table' && fixture.fields < 3)
  ) {
    throw new Error('Fixture exceeds the bounded corpus contract');
  }
}

export function buildCorpus(fixture: BenchmarkCase): Corpus {
  checkCase(fixture);
  const files: Corpus['files'] = [];
  let conversation: object | null = null;
  // Integer-only generator makes the corpus byte stable on all supported hosts.
  let state = fixture.seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state.toString(16);
  };
  if (fixture.kind === 'table') {
    const names = Array.from({ length: fixture.fields }, (_, i) => `field${i}`);
    const fields = names
      .map((name, i) => {
        if (fixture.shape === 'relations' && i === 0)
          return `  ${name}: { kind: relation, target: Benchmark }`;
        if (fixture.shape === 'relations' && i === 1)
          return `  ${name}: { kind: rollup, relation: field0, property: field2, calculate: sum }`;
        return `  ${name}: { kind: ${fixture.shape === 'relations' && i === 2 ? 'number' : 'text'} }`;
      })
      .join('\n');
    const columns = names
      .map(
        (name) =>
          `{ field: ${name}, width: 140${fixture.shape === 'wrapped' ? ', wrap: true' : ''} }`,
      )
      .join(', ');
    files.push({
      path: 'types/benchmark.md',
      content: `---\ntype: Type\nfields:\n${fields}\nviews:\n  - id: benchmark\n    name: All\n    filters: null\n    presentation:\n      type: table\n      group: []\n      sort: []\n      limit: ${fixture.count}\n      columns: [${columns}]\n---\n# Benchmark\n`,
    });
    for (let i = 0; i < fixture.count; i++) {
      const values = names.flatMap((name, field) => {
        if (fixture.shape === 'sparse' && (i + field) % 7 !== 0) return [];
        if (fixture.shape === 'relations' && field === 0)
          return [`${name}: ['[[${String((i + 1) % fixture.count).padStart(5, '0')}]]']`];
        if (fixture.shape === 'relations' && field === 1) return [];
        if (fixture.shape === 'relations' && field === 2) return [`${name}: ${i}`];
        const value = `Value ${i} ${next()}`;
        if (fixture.shape === 'wrapped')
          return [
            `${name}: ${JSON.stringify(`${value}\nSecond line with enough words to wrap\nThird line`)}`,
          ];
        return [
          `${name}: ${JSON.stringify(fixture.shape === 'long' ? `${value} `.repeat(32) : value)}`,
        ];
      });
      files.push({
        path: `benchmark/${String(i).padStart(5, '0')}.md`,
        content: `---\ntype: Benchmark\n${values.join('\n')}\n---\n# Benchmark record ${i}\n`,
      });
    }
  } else if (fixture.kind === 'document') {
    const heading = '# Benchmark document\n\n';
    const paragraph = `## Section ${next()}\n\nA repeatable paragraph with **formatting**, a [local link](./other.md) and enough words to parse.\n\n`;
    const body =
      (heading + paragraph.repeat(Math.ceil(fixture.documentBytes / paragraph.length))).slice(
        0,
        fixture.documentBytes - 21,
      ) + '\n\nPERFORMANCE END\n\n';
    // Pad after the complete end sentinel; exact byte size is part of the case.
    files.push({
      path: 'benchmark/document.md',
      content: body.padEnd(fixture.documentBytes, '\n'),
    });
  } else if (fixture.kind === 'search') {
    for (let i = 0; i < fixture.count; i++) {
      files.push({
        path: `benchmark/note-${i}.md`,
        content: `# Search note ${i}\n\nCorpus ${next()} common text ${i === 9999 ? 'readableneedle' : 'ordinary'}\n`,
      });
    }
    files.push({
      path: '.cerebro/performance-private.md',
      content: '# Private control\n\nprivateneedle\n',
    });
  } else {
    files.push({ path: 'benchmark/readme.md', content: '# Transcript benchmark\n' });
    conversation = {
      id: 'performance-transcript',
      title: 'Performance transcript',
      usesDefaultTitle: false,
      sessionId: null,
      createdAt: '2026-10-23T00:00:00.000Z',
      archived: false,
      vault: '/demo-vault',
      place: null,
      messages: Array.from({ length: fixture.count }, (_, i) => ({
        id: `performance-${i}`,
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `Turn ${i}: ${next()}\n\n${'A completed conversation paragraph with **formatting**. '.repeat(12)}`,
        tools: [],
      })),
    };
  }
  const bytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
  const conversationBytes =
    conversation === null ? 0 : Buffer.byteLength(JSON.stringify(conversation));
  return {
    files,
    conversation,
    manifest: {
      seed: fixture.seed,
      files: files.length,
      bytes,
      conversationBytes,
      sha256: createHash('sha256').update(JSON.stringify({ files, conversation })).digest('hex'),
    },
  };
}

const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** No overwrite, recursive mkdir, or cleanup of an admitted caller-owned path. */
export async function createOutputDirectory(requested: string, repo: string): Promise<string> {
  if (!isAbsolute(requested)) throw new Error('Output must be an explicit absolute temporary path');
  const selected = resolve(requested);
  const [parent, temporary, repository] = await Promise.all([
    realpath(dirname(selected)),
    realpath(tmpdir()),
    realpath(repo),
  ]);
  const output = join(parent, basename(selected));
  // macOS exposes both /tmp and its per-user temporary directory.
  const systemTmp = await realpath('/tmp').catch(() => temporary);
  if (
    (!within(temporary, output) && !within(systemTmp, output)) ||
    output === temporary ||
    output === systemTmp ||
    within(repository, output)
  ) {
    throw new Error('Output must be a new directory beneath system temp, outside the repository');
  }
  await mkdir(output, { recursive: false, mode: 0o700 });
  return output;
}
