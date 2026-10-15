import { describe, expect, it } from 'vitest';
import BATCH_CASES from '../../src-tauri/fixtures/batch-cases.json';
import {
  batchFailureWords,
  MAX_BATCH_BYTES,
  MAX_BATCH_OPS,
  openReportWords,
  parseBatchOps,
  revertNotAlone,
  stalePath,
  staleWords,
} from './batch';

describe('batch words (M60.6)', () => {
  it('holds the limits batch-cases.json and batch.rs hold', () => {
    expect(MAX_BATCH_OPS).toBe(BATCH_CASES.limits.maxOps);
    expect(MAX_BATCH_BYTES).toBe(BATCH_CASES.limits.maxBytes);
  });

  it('reads a stale refusal as the page by its title', () => {
    const message = staleWords('records/a.md');
    expect(stalePath(message)).toBe('records/a.md');
    expect(batchFailureWords(message, (path) => (path === 'records/a.md' ? 'Alpha' : path))).toBe(
      'Nothing was changed: “Alpha” changed while this was being prepared. Try again.',
    );
  });

  it("passes any other refusal through in the backend's words", () => {
    const message = "records/gone.md doesn't exist, so nothing was written.";
    expect(stalePath(message)).toBeNull();
    expect(batchFailureWords(message, () => 'x')).toBe(message);
  });

  it('says what an open put back, and what it left alone', () => {
    expect(openReportWords({ unfinished: 0, restored: 0, kept: 0 })).toBeNull();
    expect(openReportWords({ unfinished: 3, restored: 3, kept: 0 })).toBe(
      'Cerebro stopped partway through a change to 3 pages, so it put them back as they were.',
    );
    expect(openReportWords({ unfinished: 3, restored: 2, kept: 1 })).toBe(
      'Cerebro stopped partway through a change to 3 pages, so it put them back as they were. ' +
        '1 had changed since and were left alone.',
    );
    expect(openReportWords({ unfinished: 1, restored: 1, kept: 0 })).toBe(
      'Cerebro stopped partway through a change to 1 page, so it put them back as they were.',
    );
  });

  it('reads a revert op as batch.rs reads it (M60.7)', () => {
    const hash = 'A'.repeat(64);
    expect(
      parseBatchOps([
        {
          op: 'revert',
          path: 'records/a.md',
          afterHash: hash,
          before: 'x',
          keys: [{ key: 'status', before: 'todo', after: 'done' }],
        },
      ]),
    ).toEqual([
      {
        op: 'revert',
        path: 'records/a.md',
        afterHash: 'a'.repeat(64),
        before: 'x',
        keys: [{ key: 'status', before: 'todo', after: 'done' }],
        trashed: null,
        restored: null,
      },
    ]);
    // A revert of a delete needs no hash: its stamp names the item.
    expect(
      parseBatchOps([{ op: 'revert', path: 'records/a.md', trashed: '20261014T093000Z-a1b2' }]),
    ).toMatchObject([{ trashed: '20261014T093000Z-a1b2', afterHash: null }]);
  });

  it("refuses a revert in batch-cases.json's words", () => {
    for (const c of BATCH_CASES.cases.filter((c) => c.name.includes('revert'))) {
      const refused = (c as { refused?: string }).refused ?? '';
      if (refused.startsWith('Step ')) {
        expect(() => parseBatchOps(c.ops)).toThrow(refused);
      } else {
        expect(refused).toBe(revertNotAlone('records/a.md'));
      }
    }
    expect(() => parseBatchOps([{ op: 'revert', path: 'a.md', afterHash: 'x' }])).toThrow(
      "Step 1 can't be read: afterHash must be a 64-character hash.",
    );
    expect(() =>
      parseBatchOps([{ op: 'revert', path: 'a.md', afterHash: 'a'.repeat(64), keys: [{}] }]),
    ).toThrow("Step 1 can't be read: each of keys must name its key.");
  });
});
