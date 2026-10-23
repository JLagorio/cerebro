import { describe, expect, it } from 'vitest';
import {
  alsoByWords,
  CHANGESET_WORDS,
  changesetFileCount,
  changesetHeadline,
  fileCounts,
  isChangeset,
  keptOutOfGitWords,
  shortHash,
  upsertChangeset,
  type ChangedFile,
  type RunChangeset,
} from './changeset';

const file = (path: string, additions: number | null, deletions: number | null): ChangedFile => ({
  path,
  previous_path: null,
  kind: 'modified',
  additions,
  deletions,
  also_by: [],
});

const committed = (over: Partial<Extract<RunChangeset, { state: 'committed' }>> = {}) =>
  ({
    state: 'committed',
    run_id: 'run-1',
    commit: 'a'.repeat(40),
    files: [file('notes/a.md', 2, 1), file('notes/b.md', 1, 0)],
    additions: 3,
    deletions: 1,
    binary: 0,
    shell_unrecorded: false,
    ...over,
  }) as const satisfies RunChangeset;

describe('changeset words (M58.3)', () => {
  it('reads a commit as files and line counts', () => {
    expect(changesetHeadline(committed())).toBe('Changed 2 files · +3 −1');
    expect(
      changesetHeadline(committed({ files: [file('a.md', 1, 0)], additions: 1, deletions: 0 })),
    ).toBe('Changed 1 file · +1 −0');
  });

  it('counts binaries beside the totals, and leaves out totals it never counted', () => {
    const mixed = committed({
      files: [file('a.md', 3, 1), file('logo.png', null, null)],
      binary: 1,
    });
    expect(changesetHeadline(mixed)).toBe('Changed 2 files · +3 −1 · 1 binary');
    const allBinary = committed({
      files: [file('logo.png', null, null), file('icon.png', null, null)],
      additions: null,
      deletions: null,
      binary: 2,
    });
    expect(changesetHeadline(allBinary)).toBe('Changed 2 files · 2 binary');
    expect(changesetHeadline(allBinary)).not.toContain('+0');
  });

  it('reads a binary row as binary, never as zero', () => {
    expect(fileCounts(file('logo.png', null, null))).toBe('binary');
    expect(fileCounts(file('a.md', 0, 4))).toBe('+0 −4');
  });

  it('words every other state', () => {
    expect(
      changesetHeadline({ state: 'nothing', run_id: 'r', shell_unrecorded: false }),
    ).toBeNull();
    expect(
      changesetHeadline({ state: 'not_recorded', run_id: null, reason: 'no id', files: [] }),
    ).toBe('Changes not recorded for this turn.');
    expect(
      changesetHeadline({
        state: 'not_a_repo',
        run_id: 'r',
        files: ['a.md'],
        shell_unrecorded: false,
      }),
    ).toBe('Changed 1 file');
    expect(
      changesetHeadline({
        state: 'unavailable',
        run_id: 'r',
        reason: 'History was busy',
        files: ['a.md'],
        shell_unrecorded: false,
      }),
    ).toBe("Couldn't commit this turn's changes: History was busy.");
    expect(CHANGESET_WORDS.notARepo).toBe('Line counts and diffs need History for this vault.');
    expect(CHANGESET_WORDS.shell).toBe(
      "Shell commands this run ran may have changed other files; those aren't recorded here.",
    );
  });

  it('names who else edited a file, you first as you', () => {
    const label = (actor: string) => (actor === 'process:scout' ? 'Release scout' : actor);
    expect(alsoByWords([], label)).toBeNull();
    // A commit read back from history did not record it (M92.12): that is
    // said, never that nobody else did (CV-05).
    expect(alsoByWords(null, label)).toBe('who else edited it: not recorded');
    expect(alsoByWords(['human:me'], label)).toBe('also edited by you');
    expect(alsoByWords(['process:scout'], label)).toBe('also edited by Release scout');
    expect(alsoByWords(['human:me', 'process:scout'], label)).toBe(
      'also edited by you and Release scout',
    );
  });

  it('counts files and shows seven characters of a hash', () => {
    expect(changesetFileCount(committed())).toBe(2);
    expect(changesetFileCount({ state: 'nothing', run_id: 'r', shell_unrecorded: true })).toBe(0);
    expect(shortHash('0123456789abcdef')).toBe('0123456');
  });

  it('upserts by run, and a second run adds a second entry', () => {
    const first = committed();
    const again = committed({ additions: 9 });
    const resumed = committed({ run_id: 'run-2' });
    expect(upsertChangeset(undefined, first)).toEqual([first]);
    expect(upsertChangeset([first], again)).toEqual([again]);
    expect(upsertChangeset([first], resumed)).toEqual([first, resumed]);
  });

  it('accepts what Rust sends and refuses what it never would', () => {
    expect(isChangeset(committed())).toBe(true);
    expect(isChangeset({ state: 'nothing', run_id: 'r', shell_unrecorded: false })).toBe(true);
    expect(isChangeset({ state: 'not_recorded', run_id: null, reason: 'x', files: [] })).toBe(true);
    expect(isChangeset({ ...committed(), commit: 'not a hash' })).toBe(false);
    expect(isChangeset({ ...committed(), additions: -1 })).toBe(false);
    expect(isChangeset({ ...committed(), files: [{ path: 'a.md' }] })).toBe(false);
    expect(isChangeset({ state: 'unknown', run_id: 'r' })).toBe(false);
    expect(isChangeset(null)).toBe(false);
  });
});

it('accepts old events without a mail count and refuses invalid recorded counts', () => {
  const old = { state: 'nothing', run_id: 'old', shell_unrecorded: false };
  expect(isChangeset(old)).toBe(true);
  for (const count of [-1, 0.5, null, '2'])
    expect(isChangeset({ ...old, kept_out_of_git: count })).toBe(false);
  expect(isChangeset({ ...old, kept_out_of_git: 2 })).toBe(true);
});

// M92.12: what a changeset read back from history cannot know is null, which
// says not recorded wherever it is drawn, and which no stored event holds.
it('reads a changeset read back from history as not recorded where it cannot know', () => {
  const healed = {
    ...committed({ files: [{ ...file('a.md', 1, 0), also_by: null }] }),
    kept_out_of_git: null,
    shell_unrecorded: null,
  } satisfies RunChangeset;
  expect(keptOutOfGitWords(healed)).toBeNull();
  expect(keptOutOfGitWords({ ...healed, kept_out_of_git: 2 })).toBe(
    'Kept 2 mail files out of git.',
  );
  expect(alsoByWords(healed.files[0].also_by, (actor) => actor)).toBe(
    CHANGESET_WORDS.alsoByNotRecorded,
  );
  expect(changesetHeadline(healed)).toBe('Changed 1 file · +3 −1');
  // Only a run's own event is stored, and it records every field.
  expect(isChangeset(healed)).toBe(false);
  expect(isChangeset({ ...committed(), shell_unrecorded: null })).toBe(false);
  expect(isChangeset({ ...committed(), files: [{ ...file('a.md', 1, 0), also_by: null }] })).toBe(
    false,
  );
});
