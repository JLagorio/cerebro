// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import cases from '../../src-tauri/fixtures/sheet-edit-cases.json';
import { sha256Hex } from './sha256';
import * as mock from './mockIpc';
import { sheetEditReport, type SheetEditReport } from './mockSheet';
vi.mock('./mockSheet', () => ({ sheetEditReport: vi.fn() }));
const report = cases.reports[0].report as SheetEditReport;
const calculate = vi.mocked(sheetEditReport);
const PATH = 'notes/budget.md';
const PAGE = cases.reports[0].page;
const ARGS = cases.reports[0].args;
const STAMP = { actor: 'process:scout', runId: 'sheet-test' };
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const writes = () =>
  (window as unknown as { __cerebroMockWrites: mock.MockWrite[] }).__cerebroMockWrites;
beforeEach(() => {
  mock.resetMockFs();
  fs().set(PATH, PAGE);
  calculate.mockReset().mockResolvedValue(report);
});
const edit = (
  args: Record<string, unknown> = ARGS,
  path = PATH,
  options: Parameters<typeof mock.agentEditSheet>[4] = {},
) => mock.agentEditSheet('/demo-vault', path, args, STAMP, options);
describe('the mock sheet edit door', () => {
  it('writes once, keeps the prefix, keeps formulas, and reports the new hash and stamp', async () => {
    fs().set(PATH, '\uFEFF---\r\ntitle: Budget\r\n--- \r\n' + PAGE);
    const answer = JSON.parse(await edit());
    expect(answer).toMatchObject({ path: PATH, wrote: true, ...report });
    expect(fs().get(PATH)).toContain('1,4,=SUM(A1:B1)');
    expect(fs().get(PATH)).toMatch(/^\uFEFF---\r\ntitle: Budget\r\n--- \r\n/);
    expect(answer.hash).toBe(sha256Hex(fs().get(PATH)!));
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ path: PATH, actor: STAMP.actor, runId: STAMP.runId });
  });
  it('checks shape before bundle, and bundle before detailed ops', async () => {
    await expect(edit({}, 'knowledge/concept.md')).rejects.toThrow('edit_sheet needs `ops`');
    await expect(
      edit({ ops: Array(26).fill({ op: 'add_sheet', name: 'X' }) }, 'knowledge/concept.md'),
    ).rejects.toThrow('write_concept');
    expect(calculate).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it('refuses hidden, nonnote, missing, and governed targets without computing', async () => {
    for (const path of ['.git/config', 'attachments/a.md', 'diagram.mmd', 'missing.md'])
      await expect(edit(ARGS, path)).rejects.toThrow();
    for (const type of ['Type', 'Agent']) {
      fs().set(PATH, `---\ntype: ${type}\n---\n` + PAGE);
      await expect(edit({ ops: [] })).rejects.toThrow();
    }
    expect(calculate).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
  it('a stale hash precedes even invalid ops and leaves every byte', async () => {
    await expect(edit({ expect_hash: '0'.repeat(64), ops: [] })).rejects.toThrow('stale_content');
    expect(fs().get(PATH)).toBe(PAGE);
    expect(calculate).not.toHaveBeenCalled();
  });
  it('a malformed hash writes nothing', async () => {
    await expect(edit({ ...ARGS, expect_hash: 'bad' })).rejects.toThrow('64-character');
    expect(writes()).toEqual([]);
  });
  it('refuses 26 operations before computing or writing', async () => {
    await expect(edit({ ops: Array(26).fill({ op: 'add_sheet', name: 'X' }) })).rejects.toThrow(
      'at most 25 ops',
    );
    expect(fs().get(PATH)).toBe(PAGE);
    expect(calculate).not.toHaveBeenCalled();
  });
  it('the same bytes write and record nothing', async () => {
    const answer = JSON.parse(
      await edit({
        ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ address: 'A1', value: '1' }] }],
      }),
    );
    expect(answer.wrote).toBe(false);
    expect(writes()).toEqual([]);
    expect(fs().get(PATH)).toBe(PAGE);
  });
  it('preview computes but never mutates the disk or write log', async () => {
    const answer = JSON.parse(await edit(ARGS, PATH, { preview: true }));
    expect(answer.wrote).toBe(true);
    expect(fs().get(PATH)).toBe(PAGE);
    expect(writes()).toEqual([]);
  });
  it('add_sheet cannot complete an unclosed byte-zero properties block', async () => {
    const raw = '---\ntitle: Original\n';
    fs().set(PATH, raw);
    await expect(edit({ ops: [{ op: 'add_sheet', name: 'Budget' }] })).rejects.toThrow(
      "page's properties",
    );
    expect(fs().get(PATH)).toBe(raw);
    expect(calculate).not.toHaveBeenCalled();
  });
  it('engine failures refuse the whole edit', async () => {
    calculate.mockRejectedValueOnce(new Error('stopped'));
    await expect(edit()).rejects.toThrow(
      "The sheets couldn't be computed (stopped).\nNothing was written.",
    );
    expect(fs().get(PATH)).toBe(PAGE);
    expect(writes()).toEqual([]);
  });
  it('a concurrent source edit is never overwritten after computation', async () => {
    calculate.mockImplementationOnce(async () => {
      fs().set(PATH, PAGE + 'Outside.\n');
      return report;
    });
    await expect(edit()).rejects.toThrow('stale_content');
    expect(fs().get(PATH)).toBe(PAGE + 'Outside.\n');
    expect(writes()).toEqual([]);
  });
  it('a reset during computation cannot write into the new mock vault', async () => {
    calculate.mockImplementationOnce(async () => {
      mock.resetMockFs();
      fs().set(PATH, PAGE);
      return report;
    });
    await expect(edit()).rejects.toThrow('active run');
    expect(fs().get(PATH)).toBe(PAGE);
    expect(writes()).toEqual([]);
  });
  it('a stopped run cannot land its pending calculation', async () => {
    await expect(edit(ARGS, PATH, { alive: () => false })).rejects.toThrow('active run');
    expect(writes()).toEqual([]);
  });
  it('a queued preview does not roll back unrelated writes made while it calculated', async () => {
    calculate.mockImplementationOnce(async () => {
      fs().set('notes/other.md', 'Other writer');
      return report;
    });
    expect(await mock.agentWriteRefusal('/demo-vault', 'edit_sheet', ARGS)).toBeNull();
    expect(fs().get('notes/other.md')).toBe('Other writer');
    expect(fs().get(PATH)).toBe(PAGE);
    expect(writes()).toEqual([]);
  });
});
