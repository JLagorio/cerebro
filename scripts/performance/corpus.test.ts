// @vitest-environment node
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCorpus, createOutputDirectory, reliabilityMatrix } from './corpus';

const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch() {
  const path = await mkdtemp(join(tmpdir(), 'cerebro-perf-test-'));
  owned.push(path);
  return realpath(path);
}

describe('repeatable performance corpus', () => {
  it('replays exact bytes and fingerprints from a declared seed without touching the golden vault', () => {
    const fixture = reliabilityMatrix(93).find((row) => row.id === 'table-100x12')!;
    const a = buildCorpus(fixture);
    const b = buildCorpus(fixture);
    expect(a).toEqual(b);
    expect(a.files).toHaveLength(101);
    expect(a.files[0].content).toContain('limit: 100');
    expect(a.manifest.bytes).toBe(
      a.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0),
    );
    expect(buildCorpus({ ...fixture, seed: 94 }).manifest.sha256).not.toBe(a.manifest.sha256);
    expect(a.files.every((file) => !file.path.includes('demo-vault'))).toBe(true);
  });

  it('declares both widths at each scale and every required workload shape', () => {
    const matrix = reliabilityMatrix();
    for (const count of [100, 1000, 5000]) {
      for (const fields of [12, 24]) {
        expect(matrix).toContainEqual(expect.objectContaining({ count, fields, shape: 'short' }));
      }
    }
    expect(matrix.map((row) => row.shape)).toEqual(
      expect.arrayContaining(['long', 'sparse', 'wrapped', 'relations']),
    );
    expect(matrix).toContainEqual(expect.objectContaining({ kind: 'search', count: 10000 }));
    expect(matrix).toContainEqual(
      expect.objectContaining({ kind: 'document', documentBytes: 262144 }),
    );
    expect(matrix).toContainEqual(expect.objectContaining({ kind: 'transcript', count: 1000 }));
  });

  it('creates bounded exact-size document bytes and distinct readable/private search needles', () => {
    const matrix = reliabilityMatrix();
    const document = buildCorpus(matrix.find((row) => row.id === 'document-256k')!);
    expect(Buffer.byteLength(document.files[0].content)).toBe(262144);
    const search = buildCorpus(matrix.find((row) => row.kind === 'search')!);
    expect(search.files.filter((file) => file.path.startsWith('benchmark/'))).toHaveLength(10000);
    expect(
      search.files.some(
        (file) => file.path.startsWith('.cerebro/') && file.content.includes('privateneedle'),
      ),
    ).toBe(true);
    expect(search.files.filter((file) => file.content.includes('readableneedle'))).toHaveLength(1);
    expect(() => buildCorpus({ ...matrix[0], count: 1000000 })).toThrow(/bound/i);
  });

  it('actually enables variable-height wrapping and declares an evaluated relation rollup', () => {
    const matrix = reliabilityMatrix();
    const wrapped = buildCorpus(matrix.find((row) => row.shape === 'wrapped')!);
    expect(wrapped.files[0].content.match(/wrap: true/g)).toHaveLength(12);
    const related = buildCorpus(matrix.find((row) => row.shape === 'relations')!);
    expect(related.files[0].content).toContain(
      'relation: field0, property: field2, calculate: sum',
    );
    expect(related.files[1].content).toContain("field0: ['[[00001]]']");
    expect(related.files[1].content).not.toMatch(/^field1:/m);
  });
});

describe('disposable output admission', () => {
  it('creates one explicitly selected new temporary directory and never replaces existing content', async () => {
    const parent = await scratch();
    const output = join(parent, 'run');
    await expect(createOutputDirectory(output, process.cwd())).resolves.toBe(output);
    await writeFile(join(output, 'keep'), 'untouched');
    await expect(createOutputDirectory(output, process.cwd())).rejects.toThrow(/exist/i);
    expect(await readFile(join(output, 'keep'), 'utf8')).toBe('untouched');
  });

  it('refuses temp roots, relative paths, repository paths and symlink escapes', async () => {
    await expect(createOutputDirectory(tmpdir(), process.cwd())).rejects.toThrow();
    await expect(createOutputDirectory('relative-output', process.cwd())).rejects.toThrow();
    await expect(
      createOutputDirectory(join(process.cwd(), 'demo-vault'), process.cwd()),
    ).rejects.toThrow();
    const parent = await scratch();
    await symlink(process.cwd(), join(parent, 'escape'));
    await expect(
      createOutputDirectory(join(parent, 'escape', 'forbidden-output'), process.cwd()),
    ).rejects.toThrow();
    // Even a repository checked out beneath /tmp must not become output.
    await expect(createOutputDirectory(join(parent, 'nested'), parent)).rejects.toThrow();
  });
});
