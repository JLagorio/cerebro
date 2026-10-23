import { describe, expect, it } from 'vitest';
import type { ChangedFile, ChangeKind, RunChangeset } from '@/engine/changeset';
import {
  foldConversationChanges,
  type ConversationChanges,
  type ConversationFile,
  type TurnChanges,
} from './conversationChanges';

const file = (
  path: string,
  kind: ChangeKind,
  additions: number | null = 1,
  deletions: number | null = 0,
  over: Partial<ChangedFile> = {},
): ChangedFile => ({ path, previous_path: null, kind, additions, deletions, also_by: [], ...over });

const renamed = (from: string, to: string, additions = 1, deletions = 0): ChangedFile =>
  file(to, 'renamed', additions, deletions, { previous_path: from });

let runs = 0;
const committed = (files: ChangedFile[], over: { run_id?: string; commit?: string } = {}) => {
  runs += 1;
  const run = over.run_id ?? `run-${runs}`;
  return {
    state: 'committed',
    run_id: run,
    commit: over.commit ?? runs.toString(16).padStart(7, '0'),
    files,
    additions: null,
    deletions: null,
    binary: 0,
    shell_unrecorded: false,
  } satisfies RunChangeset;
};

const nothing = (): RunChangeset => {
  runs += 1;
  return { state: 'nothing', run_id: `run-${runs}`, shell_unrecorded: false };
};

const turn = (id: string, ...changesets: RunChangeset[]): TurnChanges => ({
  turn: id,
  changesets,
});

/** Each run in its own turn, `t1`, `t2`, …, oldest first. */
const fold = (...perRun: ChangedFile[][]): ConversationChanges =>
  foldConversationChanges(perRun.map((files, i) => turn(`t${i + 1}`, committed(files))));

const counts = (row: ConversationFile) =>
  row.additions === null || row.deletions === null
    ? 'uncounted'
    : `+${row.additions} −${row.deletions}`;

/** Each row as `kind path (from previous) counts`, groups in order, then
 * what was dropped. */
function outline(changes: ConversationChanges): string[] {
  return [
    ...[...changes.added, ...changes.others].map(
      (row) =>
        `${row.kind ?? 'unknown'} ${row.path}${row.previousPath === undefined ? '' : ` (from ${row.previousPath})`} ${counts(row)}`,
    ),
    ...changes.dropped.map((path) => `dropped ${path}`),
  ];
}

describe('the net kind across runs', () => {
  it.each<[string, ChangedFile[][], string[]]>([
    [
      'added then modified stays added',
      [[file('a.md', 'added', 3, 0)], [file('a.md', 'modified', 2, 1)]],
      ['added a.md +5 −1'],
    ],
    [
      'added then deleted leaves no row, and notes it',
      [[file('draft.md', 'added', 4, 0)], [file('draft.md', 'deleted', 0, 4)]],
      ['dropped draft.md'],
    ],
    [
      'a rename renamed again is one rename from where it began',
      [[renamed('a.md', 'b.md', 0, 1)], [renamed('b.md', 'c.md', 2, 1)]],
      ['renamed c.md (from a.md) +2 −2'],
    ],
    [
      'added then renamed is added where it ended',
      [[file('x.md', 'added', 2, 0)], [renamed('x.md', 'y.md', 1, 0)]],
      ['added y.md +3 −0'],
    ],
    [
      'modified then renamed is a rename',
      [[file('a.md', 'modified', 1, 1)], [renamed('a.md', 'b.md', 2, 0)]],
      ['renamed b.md (from a.md) +3 −1'],
    ],
    [
      'renamed then modified is a rename',
      [[renamed('a.md', 'b.md', 1, 0)], [file('b.md', 'modified', 2, 0)]],
      ['renamed b.md (from a.md) +3 −0'],
    ],
    [
      'renamed then deleted is deleted, from where it began',
      [[renamed('a.md', 'b.md', 1, 0)], [file('b.md', 'deleted', 0, 3)]],
      ['deleted b.md (from a.md) +1 −3'],
    ],
    [
      'renamed and renamed back is modified',
      [[renamed('a.md', 'b.md', 1, 0)], [renamed('b.md', 'a.md', 0, 1)]],
      ['modified a.md +1 −1'],
    ],
    [
      'deleted then written again is the file it was',
      [[file('a.md', 'deleted', 0, 5)], [file('a.md', 'added', 2, 0)]],
      ['modified a.md +2 −5'],
    ],
    [
      'added, deleted and added again stays added',
      [
        [file('a.md', 'added', 1, 0)],
        [file('a.md', 'deleted', 0, 1)],
        [file('a.md', 'added', 3, 0)],
      ],
      ['added a.md +4 −1'],
    ],
    [
      'added, renamed and deleted is dropped where it ended',
      [[file('x.md', 'added')], [renamed('x.md', 'y.md')], [file('y.md', 'deleted', 0, 1)]],
      ['dropped y.md'],
    ],
    [
      'modified then deleted is deleted',
      [[file('a.md', 'modified', 1, 0)], [file('a.md', 'deleted', 0, 2)]],
      ['deleted a.md +1 −2'],
    ],
    [
      'two files keep their own chains in one run',
      [[renamed('a.md', 'b.md'), file('c.md', 'added', 2, 0)], [file('b.md', 'modified', 1, 1)]],
      ['added c.md +2 −0', 'renamed b.md (from a.md) +2 −1'],
    ],
  ])('%s', (_, perRun, rows) => {
    expect(outline(fold(...perRun))).toEqual(rows);
  });

  it.each<[string, ChangedFile[], string[]]>([
    [
      'a file added where another moved from, the add listed first',
      [file('notes/x.md', 'added', 2, 0), renamed('notes/x.md', 'x-old.md', 0, 0)],
      ['added notes/x.md +2 −0', 'renamed x-old.md (from notes/x.md) +0 −0'],
    ],
    [
      'a shift, the first move listed first',
      [renamed('a.md', 'b.md'), renamed('b.md', 'c.md')],
      ['renamed b.md (from a.md) +1 −0', 'renamed c.md (from b.md) +1 −0'],
    ],
    [
      'a swap',
      [renamed('a.md', 'b.md', 1, 0), renamed('b.md', 'a.md', 2, 0)],
      ['renamed a.md (from b.md) +2 −0', 'renamed b.md (from a.md) +1 −0'],
    ],
  ])('moves one run’s renames at once, in any order: %s', (_, files, rows) => {
    expect(outline(fold(files))).toEqual(rows);
    expect(outline(fold([...files].reverse()))).toEqual(rows);
  });

  it('follows a file one run moved into a later run’s rename', () => {
    expect(
      outline(
        fold(
          [file('notes/x.md', 'added'), renamed('notes/x.md', 'x-old.md')],
          [renamed('x-old.md', 'archive/x.md')],
        ),
      ),
    ).toEqual(['added notes/x.md +1 −0', 'renamed archive/x.md (from notes/x.md) +2 −0']);
  });

  it('reads a rename that names no previous path as a change in place', () => {
    expect(outline(fold([file('b.md', 'renamed', 1, 0)]))).toEqual(['modified b.md +1 −0']);
  });
});

describe('the groups', () => {
  it('puts the files the conversation added first, each group by path, numbers in counting order', () => {
    const changes = fold(
      [file('notes/b.md', 'modified'), file('notes/day10.md', 'added'), file('old.md', 'deleted')],
      [file('notes/a.md', 'added'), renamed('x.md', 'notes/c.md'), file('notes/day9.md', 'added')],
    );
    expect(changes.added.map((row) => row.path)).toEqual([
      'notes/a.md',
      'notes/day9.md',
      'notes/day10.md',
    ]);
    expect(changes.others.map((row) => `${row.kind} ${row.path}`)).toEqual([
      'modified notes/b.md',
      'renamed notes/c.md',
      'deleted old.md',
    ]);
  });
});

describe('the counts', () => {
  it('sums what each run counted', () => {
    const [row] = fold([file('a.md', 'modified', 3, 1)], [file('a.md', 'modified', 2, 2)]).others;
    expect(row).toMatchObject({ additions: 5, deletions: 3 });
  });

  it('is null when any run left the file uncounted, however the others counted it', () => {
    const binary = fold(
      [file('logo.png', 'modified', null, null)],
      [file('logo.png', 'modified', 4, 1)],
    );
    expect(binary.others[0]).toMatchObject({ kind: 'modified', additions: null, deletions: null });
    const oneSide = fold([file('a.md', 'modified', 2, 1)], [file('a.md', 'modified', 3, null)]);
    expect(oneSide.others[0]).toMatchObject({ additions: null, deletions: null });
  });

  it('is null, and so is the kind, where a run named the file without its commit', () => {
    const changes = foldConversationChanges([
      turn('t1', committed([file('a.md', 'added', 3, 0)], { commit: 'aaaaaaa' })),
      turn('t2', {
        state: 'unavailable',
        run_id: 'run-failed',
        reason: 'History was busy',
        files: ['a.md', 'b.md'],
        shell_unrecorded: false,
      }),
    ]);
    expect(outline(changes)).toEqual(['unknown a.md uncounted', 'unknown b.md uncounted']);
    expect(changes.others[0]).toMatchObject({ turn: 't2', commit: 'aaaaaaa' });
    expect(changes.others[1]).toMatchObject({ turn: 't2', commit: null });
  });

  it('keeps a zero git counted, which is not an uncounted file', () => {
    const changes = fold([renamed('a.md', 'b.md', 0, 0)]);
    expect(changes.others[0]).toMatchObject({ additions: 0, deletions: 0 });
    expect(changes).toMatchObject({ additions: 0, deletions: 0, uncounted: 0, state: 'ready' });
  });

  it('totals only the rows git counted, says how many it left out, and never totals none as zero', () => {
    const mixed = fold([file('a.md', 'modified', 3, 1), file('logo.png', 'added', null, null)]);
    expect(mixed).toMatchObject({ additions: 3, deletions: 1, uncounted: 1, state: 'partial' });
    const none = fold([file('a.png', 'added', null, null), file('b.png', 'modified', null, null)]);
    expect(none).toMatchObject({ additions: null, deletions: null, uncounted: 2 });
  });

  it('leaves a dropped file out of the totals as well as the rows', () => {
    const changes = fold(
      [file('draft.md', 'added', 9, 0), file('a.md', 'modified', 1, 0)],
      [file('draft.md', 'deleted', 0, 9)],
    );
    expect(changes).toMatchObject({ additions: 1, deletions: 0, dropped: ['draft.md'] });
  });
});

describe('nothing changed versus no changeset', () => {
  it('is empty when every run said it changed nothing', () => {
    expect(foldConversationChanges([turn('t1', nothing()), turn('t2', nothing())])).toMatchObject({
      state: 'empty',
      notRecorded: 0,
      turns: 0,
      additions: null,
      deletions: null,
    });
    expect(foldConversationChanges([])).toMatchObject({ state: 'empty', notRecorded: 0 });
  });

  it('is not recorded when finished turns hold no changeset, never empty', () => {
    expect(foldConversationChanges([turn('t1'), turn('t2')])).toMatchObject({
      state: 'not_recorded',
      notRecorded: 2,
    });
  });

  it('counts a changeset that says not recorded as a turn not recorded, listing none of its files as its footer lists none', () => {
    const changes = foldConversationChanges([
      turn('t1', { state: 'not_recorded', run_id: null, reason: 'no id', files: ['a.md'] }),
    ]);
    expect(changes).toMatchObject({ state: 'not_recorded', notRecorded: 1, others: [] });
  });

  it('is partial when some turns measured nothing and others were not recorded', () => {
    expect(foldConversationChanges([turn('t1', nothing()), turn('t2')])).toMatchObject({
      state: 'partial',
      notRecorded: 1,
    });
  });

  it('is partial when rows stand beside a turn not recorded', () => {
    const changes = foldConversationChanges([
      turn('t1', committed([file('a.md', 'added')])),
      turn('t2'),
    ]);
    expect(changes).toMatchObject({ state: 'partial', notRecorded: 1, turns: 1 });
  });

  it('is ready when every row is counted and every turn recorded', () => {
    const changes = foldConversationChanges([
      turn('t1', committed([file('a.md', 'added')])),
      turn('t2', nothing()),
    ]);
    expect(changes).toMatchObject({ state: 'ready', notRecorded: 0, turns: 1 });
  });

  it('is ready with a dropped file alone: there is a note to make', () => {
    const changes = fold([file('draft.md', 'added')], [file('draft.md', 'deleted', 0, 1)]);
    expect(changes).toMatchObject({ state: 'ready', added: [], others: [], dropped: ['draft.md'] });
  });

  it('waits on a turn still running rather than calling it not recorded', () => {
    expect(
      foldConversationChanges([turn('t1', nothing()), { ...turn('t2'), running: true }]),
    ).toMatchObject({ state: 'empty', pending: true, notRecorded: 0 });
    const resumed = foldConversationChanges([
      { ...turn('t1', committed([file('a.md', 'added')])), running: true },
    ]);
    expect(resumed).toMatchObject({ state: 'ready', pending: true, turns: 1 });
  });
});

describe('each row', () => {
  it('names the latest reply that changed it, and the latest commit that carried it', () => {
    const changes = foldConversationChanges([
      turn('t1', committed([file('a.md', 'modified')], { commit: 'aaaaaaa' })),
      turn('t2', committed([file('b.md', 'modified')], { commit: 'bbbbbbb' })),
      turn(
        't3',
        committed([file('a.md', 'modified')], { commit: 'ccccccc' }),
        committed([file('a.md', 'deleted', 0, 2)], { commit: 'ddddddd' }),
      ),
    ]);
    expect(changes.others.map((row) => [row.kind, row.path, row.turn, row.commit])).toEqual([
      ['deleted', 'a.md', 't3', 'ddddddd'],
      ['modified', 'b.md', 't2', 'bbbbbbb'],
    ]);
  });

  it('names everyone else whose edits rode in its commits, once each', () => {
    const changes = fold(
      [file('a.md', 'modified', 1, 0, { also_by: ['human:me'] })],
      [file('a.md', 'modified', 1, 0, { also_by: ['process:scout', 'human:me'] })],
    );
    expect(changes.others[0].alsoBy).toEqual(['human:me', 'process:scout']);
  });

  it('says who else wrote it was not recorded where a commit did not record it', () => {
    // A commit healed from history (M92.12) records no also_by.
    const healed = { ...file('a.md', 'modified'), also_by: null } as unknown as ChangedFile;
    const changes = fold([file('a.md', 'modified', 1, 0, { also_by: ['human:me'] })], [healed]);
    expect(changes.others[0].alsoBy).toBeNull();
    expect(
      fold([healed], [file('a.md', 'modified', 1, 0, { also_by: ['human:me'] })]).others[0].alsoBy,
    ).toBeNull();
  });

  it('is copied only when every turn that changed it was copied into the branch', () => {
    const changes = foldConversationChanges([
      { ...turn('t1', committed([file('a.md', 'added'), file('b.md', 'modified')])), copied: true },
      turn('t2', committed([file('b.md', 'modified')])),
      turn('t3', nothing()),
    ]);
    expect(changes.added[0]).toMatchObject({ path: 'a.md', copied: true });
    expect(changes.others[0]).toMatchObject({ path: 'b.md', copied: false });
    expect(changes).toMatchObject({ turns: 2, copiedTurns: 1 });
  });
});

describe('what the card says beside the rows', () => {
  it('counts the turns whose runs changed files, a resumed turn once', () => {
    const changes = foldConversationChanges([
      turn('t1', committed([file('a.md', 'added')]), committed([file('b.md', 'added')])),
      turn('t2', nothing()),
      turn('t3', committed([file('a.md', 'modified')])),
    ]);
    expect(changes.turns).toBe(2);
  });

  it('counts the turns that could not commit, and says when a vault keeps no history', () => {
    const changes = foldConversationChanges([
      turn('t1', {
        state: 'not_a_repo',
        run_id: 'run-a',
        files: ['a.md'],
        shell_unrecorded: false,
      }),
      turn('t2', {
        state: 'unavailable',
        run_id: 'run-b',
        reason: 'Cerebro was quitting',
        files: ['b.md'],
        shell_unrecorded: false,
      }),
    ]);
    expect(changes).toMatchObject({ uncommitted: 1, noHistory: true, turns: 2, state: 'partial' });
    expect(changes.commits).toEqual([]);
  });

  it('counts the turns whose shell may have changed files nobody recorded', () => {
    const changes = foldConversationChanges([
      turn('t1', { state: 'nothing', run_id: 'run-a', shell_unrecorded: true }),
      turn('t2', { ...committed([file('a.md', 'added')]), shell_unrecorded: true }),
      turn('t3', committed([file('b.md', 'added')])),
    ]);
    expect(changes.shellUnrecorded).toBe(2);
  });

  it('lists every committed run, oldest first, for the diff a commit opens with', () => {
    const changes = foldConversationChanges([
      turn('t1', committed([file('a.md', 'added')], { run_id: 'run-a', commit: 'aaaaaaa' })),
      turn('t2', nothing()),
      turn('t3', committed([file('a.md', 'deleted')], { run_id: 'run-b', commit: 'bbbbbbb' })),
    ]);
    expect(changes.commits).toEqual([
      { commit: 'aaaaaaa', runId: 'run-a', turn: 't1' },
      { commit: 'bbbbbbb', runId: 'run-b', turn: 't3' },
    ]);
    expect(changes.dropped).toEqual(['a.md']);
  });

  it('folds a run listed twice once, so no count doubles', () => {
    const once = committed([file('a.md', 'modified', 2, 1)], { run_id: 'run-a' });
    const changes = foldConversationChanges([turn('t1', once), turn('t2', once)]);
    expect(changes.others[0]).toMatchObject({ additions: 2, deletions: 1, turn: 't1' });
    expect(changes).toMatchObject({ commits: [{ runId: 'run-a' }], turns: 1, notRecorded: 0 });
  });
});
