import { describe, expect, it } from 'vitest';
import { diffEntries, observeScan, type ScanBaseline } from './events';
import { makeEntry } from './testHelpers';

// Each version has new bytes, so its hash moves with its stamp (M55.2).
const note = (path: string, modifiedAt: string, createdAt = '2026-07-01T00:00:00Z') =>
  makeEntry({ path, title: path, createdAt, modifiedAt, hash: `h:${modifiedAt}` });

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

/**
 * M55.2: a change is new bytes. `changed` compares hashes, never a stamp, and
 * a version whose bytes are not known yet is held back until they are.
 */
describe('a change is new bytes (M55.2)', () => {
  const at = (hash: string | null, modifiedAt: string, status = 'open') =>
    makeEntry({
      path: 'inbox/a.md',
      title: 'A',
      createdAt: '2026-07-01T00:00:00Z',
      modifiedAt,
      hash,
      properties: { status },
    });
  const v1 = at('h1', '2026-07-01T09:00:00Z');

  it('a touch or an identical re-save fires nothing', () => {
    expect(diffEntries([v1], [at('h1', '2026-07-02T09:00:00Z')])).toEqual([]);
  });

  it('a rewrite within the same second still fires', () => {
    const rewritten = at('h2', v1.modifiedAt, 'done');
    expect(diffEntries([v1], [rewritten])).toEqual([
      { kind: 'changed', path: 'inbox/a.md', entry: rewritten, before: v1, fields: ['status'] },
    ]);
  });

  it('a version whose hash is not known fires nothing, and the baseline keeps the last known', () => {
    const first = observeScan(null, '/a', [v1]);
    // The optimistic edit: new fields, a new stamp, and no hash yet.
    const optimistic = at(null, '2026-07-01T09:00:00.123Z', 'done');
    const pending = observeScan(first.baseline, '/a', [optimistic]);
    expect(pending.events).toEqual([]);
    expect(pending.baseline.entries).toEqual([v1]);
    // The write answers: one event, measured against the last known version.
    const landed = at('h2', '2026-07-01T09:00:00.123Z', 'done');
    const answered = observeScan(pending.baseline, '/a', [landed]);
    expect(answered.events).toEqual([
      { kind: 'changed', path: 'inbox/a.md', entry: landed, before: v1, fields: ['status'] },
    ]);
    // …and the rescan that brings the same bytes at Rust's stamp is no change.
    const rescanned = at('h2', '2026-07-01T09:00:01Z', 'done');
    expect(observeScan(answered.baseline, '/a', [rescanned]).events).toEqual([]);
  });

  it('a failed write that returns to the old bytes fires nothing', () => {
    const first = observeScan(null, '/a', [v1]);
    const pending = observeScan(first.baseline, '/a', [at(null, '2026-07-01T09:00:00.5Z', 'done')]);
    const reverted = observeScan(pending.baseline, '/a', [at('h1', '2026-07-01T09:00:00Z')]);
    expect(reverted.events).toEqual([]);
  });

  it('an unreadable file never fires changed', () => {
    const unreadable = at(null, '2026-07-01T09:00:00Z');
    const first = observeScan(null, '/a', [unreadable]);
    const still = observeScan(first.baseline, '/a', [at(null, '2026-07-02T09:00:00Z')]);
    expect(still.events).toEqual([]);
    // Readable again: there is no known version to measure it against.
    expect(observeScan(still.baseline, '/a', [at('h3', '2026-07-03T09:00:00Z')]).events).toEqual(
      [],
    );
    expect(diffEntries([v1], [unreadable])).toEqual([]);
  });

  it('a new note whose hash is not known yet is created once, not again when it lands', () => {
    const first = observeScan(null, '/a', [v1]);
    const fresh = makeEntry({ path: 'inbox/b.md', title: 'B', hash: null });
    const created = observeScan(first.baseline, '/a', [v1, fresh]);
    expect(created.events.map((e) => [e.kind, e.path])).toEqual([['created', 'inbox/b.md']]);
    const landed = observeScan(created.baseline, '/a', [v1, { ...fresh, hash: 'hb' }]);
    expect(landed.events).toEqual([]);
  });
});
