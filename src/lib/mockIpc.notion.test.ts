// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import cases from '../../src-tauri/fixtures/notion-cases.json';
import * as mock from './mockIpc';
import {
  beginMockNotionRun,
  endMockNotionRun,
  seedNotionCapture,
  type MockNotionCapture,
} from './mockNotion';
import { storedImportHash } from '@/engine/importSources';
const PAGE = '11111111111111111111111111111111';
const STAMP = { actor: 'process:notion', runId: 'notion-test' };
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const writes = () =>
  (window as unknown as { __cerebroMockWrites: mock.MockWrite[] }).__cerebroMockWrites;
const holder = () =>
  window as unknown as {
    __cerebroMockCaptures?: Record<string, MockNotionCapture>;
    __cerebroMockRefusals?: { run: string; code: string; target: string }[];
  };
const success: MockNotionCapture = {
  title: 'Toy page',
  result: cases.cases[0].expect as MockNotionCapture['result'],
};
const run = (
  folder = 'notion',
  body?: string,
  stamp = STAMP,
  scope: Parameters<typeof mock.agentImportNotion>[3] = {},
) => mock.agentImportNotion('/demo-vault', { page: PAGE, folder, body }, stamp, scope);
beforeEach(() => {
  mock.resetMockFs();
  delete holder().__cerebroMockCaptures;
  holder().__cerebroMockRefusals = [];
});
describe('run-owned Notion imports in the browser backend', () => {
  it('lands the Rust-normalized carriers once with a run receipt and a valid stamp', async () => {
    seedNotionCapture(STAMP.runId, PAGE, success);
    const first = await run();
    expect(first).toEqual({
      path: 'notion/toy-page.md',
      reply: 'Imported “Toy page” from Notion to notion/toy-page.md.',
      wrote: true,
    });
    const bytes = fs().get(first.path)!;
    expect(bytes).toContain(':::columns');
    expect(bytes).toContain('> [!warning]');
    expect(bytes).toContain('source_system: "notion"');
    const hash = storedImportHash(bytes)!;
    expect(hash.current).toBe(hash.stored);
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ actor: STAMP.actor, runId: STAMP.runId, path: first.path });
    expect(await run('elsewhere')).toEqual({
      path: first.path,
      reply: `${first.path} already holds this page, unchanged since its import.`,
      wrote: false,
    });
    expect(fs().get(first.path)).toBe(bytes);
    expect(writes()).toHaveLength(1);
    fs().set(first.path, bytes + '\nMy edit\n');
    expect((await run()).reply).toContain('was edited since its import');
    expect(writes()).toHaveLength(1);
  });
  it('uses the existing landing for read and write reach, without naming a hidden page', async () => {
    seedNotionCapture(STAMP.runId, PAGE, success);
    await run('private');
    await expect(run('visible', undefined, STAMP, { write: ['visible'] })).rejects.toThrow(
      'cannot write to private/toy-page.md',
    );
    await expect(run('visible', undefined, STAMP, { read: ['visible'] })).rejects.toThrow(
      'This run cannot import that page within its read reach.',
    );
    expect(fs().has('visible/toy-page.md')).toBe(false);
    expect(writes()).toHaveLength(1);
  });
  it('refuses missing captures before landing and never reads another run’s capture', async () => {
    seedNotionCapture('another-run', PAGE, success);
    await expect(run('knowledge')).rejects.toThrow('import_refused: capture_missing');
    expect(writes()).toEqual([]);
  });
  it('refuses guarded folders before interpreting a captured database result', async () => {
    seedNotionCapture(STAMP.runId, PAGE, {
      title: 'Database',
      result: {
        refusal: {
          reason: 'database_first',
          words: 'The fetch returned a database. Fetch one page instead.',
        },
      },
    });
    for (const folder of ['knowledge', 'Knowledge', 'sources', '.hidden', 'views', '../outside'])
      await expect(run(folder)).rejects.not.toThrow('database_first');
    await expect(run()).rejects.toThrow(
      'import_refused: database_first — The fetch returned a database. Fetch one page instead. Nothing was written.',
    );
    expect(writes()).toEqual([]);
  });
  it('deduplicates a typed refusal by run, reason, and page', async () => {
    for (let i = 0; i < 2; i++) await expect(run()).rejects.toThrow('capture_missing');
    expect(holder().__cerebroMockRefusals).toHaveLength(1);
    expect(holder().__cerebroMockRefusals![0]).toMatchObject({
      run: STAMP.runId,
      code: 'import_refused',
      target: `capture_missing:${PAGE}`,
    });
  });
  it('requires a composable refusal and marks an explicitly seeded fallback as composed', async () => {
    const body = '# Composed\n\nBody';
    seedNotionCapture(STAMP.runId, PAGE, {
      title: 'Toy page',
      result: {
        refusal: {
          reason: 'narrated',
          words: 'The fetch returned prose instead of a complete page envelope.',
        },
      },
      composed: { body, markdown: `---\n---\n${body}` },
    });
    await expect(run('notion', body)).rejects.toThrow('only after');
    await expect(run()).rejects.toThrow('import_refused: narrated');
    await run('notion', body);
    expect(fs().get('notion/toy-page.md')).toContain('import_method: "agent_composed"');
    seedNotionCapture(STAMP.runId, PAGE, success);
    await expect(run('notion', body)).rejects.toThrow('only after');
  });
  it('drops captures at run end and never arms a run without its tool', async () => {
    holder().__cerebroMockCaptures = { [PAGE]: success };
    beginMockNotionRun(STAMP.runId, false);
    await expect(run()).rejects.toThrow('capture_missing');
    beginMockNotionRun(STAMP.runId, true);
    await run();
    endMockNotionRun(STAMP.runId);
    await expect(run()).rejects.toThrow('capture_missing');
  });
});
