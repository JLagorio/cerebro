import { describe, expect, it } from 'vitest';
import { observeScan, type ScanBaseline } from './events';
import { makeEntry } from './testHelpers';

const note = (path: string, modifiedAt: string, createdAt = '2026-07-01T00:00:00Z') =>
  makeEntry({ path, title: path, createdAt, modifiedAt });

/**
 * The trigger diff's baseline is per vault (AUTOMATION-2b). Diffed against
 * the vault it replaced, every note in a newly opened vault read as created —
 * a scratch run fired `created` on a 2025 inbox note.
 */
describe('observeScan', () => {
  // Vault A, and a vault B whose notes would ALL be events if diffed against
  // A: a 2025 inbox note A never held (created) and the same path as one of
  // A's at another version (changed).
  const a1 = note('inbox/a1.md', '2026-07-01T09:00:00Z');
  const vaultA = [a1];
  const vaultB = [
    note('inbox/2025-03-02-call.md', '2025-03-02T10:00:00Z', '2025-03-02T10:00:00Z'),
    note('inbox/a1.md', '2026-06-15T09:00:00Z'),
  ];

  it('the first scan of a session is eventless, and the next one diffs against it', () => {
    const first = observeScan(null, '/a', vaultA);
    expect(first.events).toEqual([]);
    expect(first.baseline).toEqual({ vault: '/a', entries: vaultA });

    const edited = note('inbox/a1.md', '2026-07-02T09:00:00Z');
    const second = observeScan(first.baseline, '/a', [edited]);
    expect(second.events.map((e) => [e.kind, e.path])).toEqual([['changed', 'inbox/a1.md']]);
  });

  it("a switch is a first scan: none of the new vault's notes read as created or changed", () => {
    const inA: ScanBaseline = { vault: '/a', entries: vaultA };
    const switched = observeScan(inA, '/b', vaultB);
    expect(switched.events).toEqual([]);
    expect(switched.baseline).toEqual({ vault: '/b', entries: vaultB });
  });

  it('switching back is a first scan too — a vault that was not open was not observed', () => {
    const inB: ScanBaseline = { vault: '/b', entries: vaultB };
    // A changed while B was open: a1 was edited and a note appeared. The app
    // saw neither happen, exactly as it sees nothing while it is closed.
    const awayA = [
      note('inbox/a1.md', '2026-07-05T09:00:00Z'),
      note('inbox/new.md', '2026-07-05T10:00:00Z'),
    ];
    const back = observeScan(inB, '/a', awayA);
    expect(back.events).toEqual([]);

    // …and from there on, A is observed again.
    const later = [...awayA, note('inbox/later.md', '2026-07-06T09:00:00Z')];
    expect(observeScan(back.baseline, '/a', later).events.map((e) => [e.kind, e.path])).toEqual([
      ['created', 'inbox/later.md'],
    ]);
  });

  it('an empty scan never becomes the baseline', () => {
    const inA: ScanBaseline = { vault: '/a', entries: vaultA };
    // The store's pre-scan `[]` and an empty scan look alike; taking either
    // as the "before" would read every note in the next scan as created.
    const empty = observeScan(inA, '/a', []);
    expect(empty).toEqual({ baseline: inA, events: [] });
    const a2 = note('inbox/a2.md', '2026-07-02T09:00:00Z');
    expect(observeScan(empty.baseline, '/a', [a1, a2]).events.map((e) => e.path)).toEqual([
      'inbox/a2.md',
    ]);
  });

  it("an empty vault switched to still ends the last one's baseline", () => {
    // A → an empty B → A: B's scan holds nothing to compare against, but it
    // was a switch all the same, so the way back to A is a first scan.
    const inA: ScanBaseline = { vault: '/a', entries: vaultA };
    const emptyB = observeScan(inA, '/b', []);
    expect(emptyB.baseline).toEqual({ vault: '/b', entries: null });
    const back = observeScan(emptyB.baseline, '/a', [note('inbox/a1.md', '2026-07-09T09:00:00Z')]);
    expect(back.events).toEqual([]);
  });
});
