import { describe, expect, it } from 'vitest';
import {
  OPEN_LOG_PAGES,
  OPEN_LOG_TIMES,
  forgetOpen,
  openWeight,
  pruneOpens,
  readOpenLogs,
  recordOpen,
  remapOpens,
  type OpenLog,
  type OpenRecord,
} from './openLog';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 14, 12);

const opened = (path: string, times: number[], count = times.length): OpenRecord => ({
  path,
  opens: times,
  count,
});

describe('recordOpen', () => {
  it('puts the latest open first and counts it', () => {
    let log: OpenLog = [];
    log = recordOpen(log, 'a.md', NOW - 2);
    log = recordOpen(log, 'b.md', NOW - 1);
    log = recordOpen(log, 'a.md', NOW);
    expect(log.map((r) => r.path)).toEqual(['a.md', 'b.md']);
    expect(log[0]).toEqual({ path: 'a.md', opens: [NOW, NOW - 2], count: 2 });
  });

  it('keeps at most OPEN_LOG_TIMES times per page, and still counts every open', () => {
    let log: OpenLog = [];
    for (let i = 0; i < OPEN_LOG_TIMES + 5; i++) log = recordOpen(log, 'a.md', NOW + i);
    expect(log[0].opens).toHaveLength(OPEN_LOG_TIMES);
    expect(log[0].opens[0]).toBe(NOW + OPEN_LOG_TIMES + 4);
    expect(log[0].count).toBe(OPEN_LOG_TIMES + 5);
  });

  it('keeps at most OPEN_LOG_PAGES pages, dropping the least recent', () => {
    let log: OpenLog = [];
    for (let i = 0; i <= OPEN_LOG_PAGES; i++) log = recordOpen(log, `p${i}.md`, NOW + i);
    expect(log).toHaveLength(OPEN_LOG_PAGES);
    expect(log[0].path).toBe(`p${OPEN_LOG_PAGES}.md`);
    expect(log.some((r) => r.path === 'p0.md')).toBe(false);
  });
});

describe('openWeight', () => {
  it('two opens today outweigh twenty opens sixty days ago', () => {
    let old: OpenLog = [];
    for (let i = 0; i < 20; i++) old = recordOpen(old, 'old.md', NOW - 60 * DAY + i);
    const today = opened('new.md', [NOW, NOW - 1000]);
    expect(openWeight(today, NOW)).toBeCloseTo(2, 3);
    expect(openWeight(old[0], NOW)).toBeLessThan(0.05);
    expect(openWeight(today, NOW)).toBeGreaterThan(openWeight(old[0], NOW));
  });

  it('falls as time passes', () => {
    const record = opened('a.md', [NOW]);
    expect(openWeight(record, NOW + 30 * DAY)).toBeLessThan(openWeight(record, NOW));
  });

  it('counts a future time as age 0, never more than one open', () => {
    expect(openWeight(opened('a.md', [NOW + 5 * DAY]), NOW)).toBe(1);
  });

  it('ignores count: only the kept times weigh', () => {
    expect(openWeight(opened('a.md', [NOW], 500), NOW)).toBe(1);
  });
});

describe('remapOpens', () => {
  it('moves the exact path and every descendant, and nothing else', () => {
    const log = [
      opened('docs/old.md', [NOW]),
      opened('docs/old/page.md', [NOW - 1]),
      opened('docs/older.md', [NOW - 2]),
    ];
    expect(remapOpens(log, 'docs/old', 'docs/new').map((r) => r.path)).toEqual([
      'docs/old.md',
      'docs/new/page.md',
      'docs/older.md',
    ]);
    expect(remapOpens(log, 'docs/old.md', 'docs/renamed.md').map((r) => r.path)).toEqual([
      'docs/renamed.md',
      'docs/old/page.md',
      'docs/older.md',
    ]);
  });

  it('merges a record that lands on a logged path: times newest first, counts summed', () => {
    const log = [opened('b.md', [NOW - 10], 4), opened('a.md', [NOW, NOW - 20], 3)];
    expect(remapOpens(log, 'a.md', 'b.md')).toEqual([
      { path: 'b.md', opens: [NOW, NOW - 10, NOW - 20], count: 7 },
    ]);
  });

  it('caps the merged times', () => {
    const many = (base: number) => Array.from({ length: OPEN_LOG_TIMES }, (_, i) => base - i);
    const log = [opened('a.md', many(NOW)), opened('b.md', many(NOW - 100))];
    expect(remapOpens(log, 'b.md', 'a.md')[0].opens).toHaveLength(OPEN_LOG_TIMES);
  });
});

describe('pruneOpens and forgetOpen', () => {
  const log = [opened('a.md', [NOW]), opened('gone.md', [NOW - 1]), opened('b.md', [NOW - 2])];

  it('prune keeps only the pages that exist, in order', () => {
    const exists = new Set(['a.md', 'b.md']);
    expect(pruneOpens(log, (p) => exists.has(p)).map((r) => r.path)).toEqual(['a.md', 'b.md']);
  });

  it('prune returns the same log when nothing went', () => {
    expect(pruneOpens(log, () => true)).toBe(log);
  });

  it('forget drops one page', () => {
    expect(forgetOpen(log, 'gone.md').map((r) => r.path)).toEqual(['a.md', 'b.md']);
  });
});

describe('readOpenLogs', () => {
  it('reads the per-vault shape and drops junk', () => {
    expect(
      readOpenLogs({
        '/v': [
          { path: 'a.md', opens: [NOW - 5, NOW, 'x'], count: 1 },
          { path: 'a.md', opens: [NOW] },
          { path: '', opens: [NOW] },
          { path: 'no-times.md', opens: [] },
          'junk',
        ],
        '/w': 'junk',
      }),
    ).toEqual({ '/v': [{ path: 'a.md', opens: [NOW, NOW - 5], count: 2 }] });
  });

  it('reads a flat array, a string or null as nothing', () => {
    expect(readOpenLogs([{ path: 'a.md', opens: [NOW], count: 1 }])).toEqual({});
    expect(readOpenLogs('x')).toEqual({});
    expect(readOpenLogs(null)).toEqual({});
  });
});
