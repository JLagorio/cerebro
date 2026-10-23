import { describe, expect, it } from 'vitest';
import {
  pullRequestWords,
  RAIL_CHANGES_WORDS,
  railChanges,
  runOfCommit,
  type ChangesHeal,
  type RailChanges,
  type RailChangesInput,
} from '@/agent/elements/conversationChanges';
import type { ChatMessage, PrLink } from '@/agent/types';
import type { ChangedFile, ChangeKind, RunChangeset } from '@/engine/changeset';
import type { PrRead, PullRequest } from '@/engine/pullRequest';

const file = (
  path: string,
  kind: ChangeKind,
  additions: number | null = 1,
  deletions: number | null = 0,
  over: Partial<ChangedFile> = {},
): ChangedFile => ({ path, previous_path: null, kind, additions, deletions, also_by: [], ...over });

let made = 0;
const committed = (
  files: ChangedFile[],
  over: { run_id?: string; commit?: string; shell_unrecorded?: boolean } = {},
): RunChangeset => {
  made += 1;
  return {
    state: 'committed',
    run_id: over.run_id ?? `run-${made}`,
    commit: over.commit ?? made.toString(16).padStart(7, '0'),
    files,
    additions: null,
    deletions: null,
    binary: 0,
    shell_unrecorded: over.shell_unrecorded ?? false,
  };
};

const asked = (id: string): ChatMessage => ({
  id,
  role: 'user',
  text: 'Tidy the notes',
  tools: [],
});
const replied = (id: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'assistant',
  text: 'Done.',
  tools: [],
  ...over,
});

const NO_PRS: PrLink[] = [];

/** The card for `messages`, no turn in flight, in session `s-own`. */
const changesOf = (messages: ChatMessage[], over: Partial<RailChangesInput> = {}): RailChanges =>
  railChanges({ messages, inFlight: false, sessionId: 's-own', prLinks: NO_PRS, ...over });

/** Each row as `name: description`, groups in order. */
const rows = (changes: RailChanges) =>
  [...changes.added, ...changes.others].map((row) => `${row.name}: ${row.description}`);

const notes = (changes: RailChanges) => changes.notes.map((note) => note.text);

describe('railChanges', () => {
  it('folds each reply’s changesets, the files the conversation added first', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [
          committed([file('notes/b.md', 'modified', 3, 1), file('notes/new.md', 'added', 2, 0)]),
        ],
      }),
      asked('u-2'),
      replied('a-2', { changesets: [committed([file('notes/new.md', 'modified', 1, 1)])] }),
    ]);
    expect(changes.state).toBe('ready');
    expect(rows(changes)).toEqual(['new.md: added · +3 −1', 'b.md: modified · +3 −1']);
    expect(changes.added[0]).toMatchObject({ folder: 'notes', turn: 'a-2', kind: 'added' });
    expect(changes.others[0]).toMatchObject({ folder: 'notes', turn: 'a-1' });
    expect(changes.count).toBe('2 files');
    expect(changes.summary).toBe('+6 −2 across 2 turns');
    expect(changes.lead).toEqual([]);
    expect(changes.notes).toEqual([]);
  });

  it('is quiet with nothing changed: one line ending in None', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [{ state: 'nothing', run_id: 'run-n', shell_unrecorded: false }],
      }),
    ]);
    expect(changes).toMatchObject({
      state: 'empty',
      none: null,
      count: null,
      summary: null,
      pending: false,
    });
    expect(changesOf([])).toMatchObject({ state: 'empty' });
  });
});

describe('the heal (M92.12), merged by run id', () => {
  it('keeps a live or cached changeset over the heal’s for the same run, and adds the runs no reply holds', () => {
    const cached = committed([file('a.md', 'modified', 2, 1, { also_by: ['human:me'] })], {
      run_id: 'run-a',
      commit: 'aaaaaaa',
    });
    // The heal's own reading of run-a: other counts, and no also_by.
    const reread = committed([file('a.md', 'modified', 9, 9, { also_by: null })], {
      run_id: 'run-a',
      commit: 'aaaaaaa',
    });
    const older = committed([file('b.md', 'added', 4, 0)], { run_id: 'run-b', commit: 'bbbbbbb' });
    const heal: ChangesHeal = { state: 'read', changesets: [older, reread] };
    const changes = changesOf([asked('u-1'), replied('a-1', { changesets: [cached] })], { heal });
    expect(rows(changes)).toEqual(['b.md: added · +4 −0', 'a.md: modified · +2 −1']);
    expect(changes.others[0]).toMatchObject({ alsoBy: ['human:me'], turn: 'a-1' });
    // No reply holds run-b: its row has nowhere in the transcript to show.
    expect(changes.added[0]).toMatchObject({ turn: null, open: { kind: 'page', path: 'b.md' } });
    expect(changes.summary).toBe('+6 −1 across 2 turns');
    expect(changes.commits.map((c) => c.runId)).toEqual(['run-b', 'run-a']);
  });

  it('folds a run the heal lists twice once', () => {
    const run = committed([file('a.md', 'added', 3, 0)], { run_id: 'run-x' });
    const changes = changesOf([asked('u-1'), replied('a-1')], {
      heal: { state: 'read', changesets: [run, run] },
    });
    expect(rows(changes)).toEqual(['a.md: added · +3 −0']);
    expect(changes.summary).toBe('+3 −0 across 1 turn');
  });

  it('counts a finished reply with no changeset as not recorded until the heal reads its session’s runs', () => {
    const messages = [asked('u-1'), replied('a-1'), asked('u-2'), replied('a-2')];
    const before = changesOf(messages);
    expect(before.state).toBe('not-recorded');
    expect(notes(before)).toEqual(['Changes not recorded for 2 turns.']);
    const after = changesOf(messages, {
      heal: {
        state: 'read',
        changesets: [
          committed([file('a.md', 'modified', 1, 1)]),
          { state: 'nothing', run_id: 'run-quiet', shell_unrecorded: false },
        ],
      },
    });
    expect(after.state).toBe('ready');
    expect(notes(after)).toEqual([]);
    expect(rows(after)).toEqual(['a.md: modified · +1 −1']);
  });

  it('keeps the replies past the runs the heal read not recorded, never None (CV-05)', () => {
    const messages = [asked('u-1'), replied('a-1'), asked('u-2'), replied('a-2')];
    // Each reply ran at least one run: one run read back accounts for one.
    const fewer = changesOf(messages, {
      heal: { state: 'read', changesets: [committed([file('a.md', 'modified', 1, 1)])] },
    });
    expect(fewer.state).toBe('partial');
    expect(rows(fewer)).toEqual(['a.md: modified · +1 −1']);
    expect(notes(fewer)).toEqual(['Changes not recorded for 1 turn.']);
    // A session Cerebro holds no runs of reads nothing back.
    const none = changesOf(messages, { heal: { state: 'read', changesets: [] } });
    expect(none.state).toBe('not-recorded');
    expect(notes(none)).toEqual(['Changes not recorded for 2 turns.']);
  });

  it('says not recorded where the heal found no record of a run’s commit', () => {
    const changes = changesOf([asked('u-1'), replied('a-1')], {
      heal: {
        state: 'read',
        changesets: [{ state: 'not_recorded', run_id: 'run-r', reason: 'no record', files: [] }],
      },
    });
    expect(changes.state).toBe('not-recorded');
    expect(notes(changes)).toEqual(['Changes not recorded for 1 turn.']);
  });

  it('is unavailable when the heal read failed, whatever the replies hold, and still lists them', () => {
    const changes = changesOf(
      [asked('u-1'), replied('a-1', { changesets: [committed([file('a.md', 'added', 1, 0)])] })],
      { heal: { state: 'unavailable' } },
    );
    expect(changes.state).toBe('unavailable');
    expect(changes.lead).toEqual([{ key: 'unavailable', text: RAIL_CHANGES_WORDS.unavailable }]);
    expect(rows(changes)).toEqual(['a.md: added · +1 −0']);
  });

  it('is partial when the heal’s cap left runs out, and says so', () => {
    const changes = changesOf([asked('u-1'), replied('a-1')], {
      heal: { state: 'read', changesets: [committed([file('a.md', 'added')])], truncated: true },
    });
    expect(changes.state).toBe('partial');
    expect(notes(changes)).toEqual([RAIL_CHANGES_WORDS.truncated]);
  });
});

describe('the turn at work', () => {
  it('lands its changes when it ends: an empty card’s line reads so, never None', () => {
    const streaming = [asked('u-1'), replied('a-1', { streaming: true })];
    const changes = changesOf(streaming, { inFlight: true });
    expect(changes).toMatchObject({ state: 'empty', pending: true, lead: [] });
    expect(`${RAIL_CHANGES_WORDS.title}${changes.none}`).toBe('Changes land when this turn ends');
    expect(changesOf(streaming, { inFlight: false })).toMatchObject({ pending: false, none: null });
  });

  it('says so before the rows earlier turns changed, and keeps it while the turn waits on the person', () => {
    const messages = [
      asked('u-1'),
      replied('a-1', { changesets: [committed([file('a.md', 'added')])] }),
      asked('u-2'),
      // A held call ended the bubble's stream; its turn is still in flight.
      replied('a-2', { changesets: [committed([file('b.md', 'modified')])] }),
    ];
    const changes = changesOf(messages, { inFlight: true });
    expect(changes).toMatchObject({ state: 'ready', pending: true, none: null });
    expect(changes.lead).toEqual([{ key: 'pending', text: 'Changes land when this turn ends.' }]);
    // Its first run landed; the turn is not one nobody recorded.
    expect(notes(changes)).toEqual([]);
  });

  it('never calls the turn at work not recorded', () => {
    const changes = changesOf([asked('u-1'), replied('a-1', { streaming: true })], {
      inFlight: true,
    });
    expect(notes(changes)).toEqual([]);
  });
});

describe('a branch’s copies', () => {
  it('labels the replies a branch copied, up to the one it branched from, an anchorless one among them', () => {
    const source = { sessionId: 's-source', uuid: '00000000-0000-4000-8000-000000000001' };
    const own = { sessionId: 's-own', uuid: '00000000-0000-4000-8000-000000000002' };
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', { anchor: source, changesets: [committed([file('a.md', 'added', 2, 0)])] }),
      asked('u-2'),
      // Cut off before it named its session: still a copy.
      replied('a-2', { changesets: [committed([file('b.md', 'modified', 1, 1)])] }),
      asked('u-3'),
      replied('a-3', {
        anchor: source,
        changesets: [{ state: 'nothing', run_id: 'run-3', shell_unrecorded: false }],
      }),
      asked('u-4'),
      replied('a-4', { anchor: own, changesets: [committed([file('c.md', 'modified', 3, 0)])] }),
    ]);
    expect(rows(changes)).toEqual([
      'a.md: added · +2 −0 · copied',
      'b.md: modified · +1 −1 · copied',
      'c.md: modified · +3 −0',
    ]);
    expect(notes(changes)).toEqual(['2 turns were copied when this conversation branched.']);
  });

  it('copies nothing in a thread whose replies all ended in its own session', () => {
    const own = { sessionId: 's-own', uuid: '00000000-0000-4000-8000-000000000003' };
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', { anchor: own, changesets: [committed([file('a.md', 'added')])] }),
    ]);
    expect(rows(changes)).toEqual(['a.md: added · +1 −0']);
    expect(notes(changes)).toEqual([]);
  });
});

describe('what it cannot count (CV-05)', () => {
  it('never says “+0 −0”: a counted zero is no line changes, and a total of none says no lines', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [
          committed([
            file('b.md', 'renamed', 0, 0, { previous_path: 'a.md' }),
            file('logo.png', 'modified', null, null),
          ]),
        ],
      }),
    ]);
    expect(rows(changes)).toEqual([
      'b.md: renamed · no line changes',
      'logo.png: modified · binary',
    ]);
    expect(changes.others[0].previousPath).toBe('a.md');
    expect(changes.summary).toBe('Across 1 turn');
    expect(JSON.stringify(changes)).not.toContain('+0 −0');
  });

  it('says how many files a total leaves out', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [
          committed([file('a.md', 'modified', 3, 1), file('logo.png', 'added', null, null)]),
        ],
      }),
    ]);
    expect(changes.state).toBe('partial');
    expect(changes.summary).toBe('+3 −1 across 1 turn · 1 file without line counts');
  });

  it('reads a file no commit carried as not committed, and says why', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [
          { state: 'not_a_repo', run_id: 'run-h', files: ['a.md'], shell_unrecorded: false },
        ],
      }),
    ]);
    expect(changes.state).toBe('partial');
    expect(rows(changes)).toEqual(['a.md: not committed']);
    expect(changes.others[0]).toMatchObject({ kind: null, open: { kind: 'page', path: 'a.md' } });
    expect(notes(changes)).toEqual([RAIL_CHANGES_WORDS.noHistory]);
  });

  it('says a turn could not commit even when its run named no file, never None', () => {
    // changeset::quitting: a run that ended while Cerebro quit.
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [
          {
            state: 'unavailable',
            run_id: 'run-q',
            reason: 'Cerebro was quitting',
            files: [],
            shell_unrecorded: false,
          },
        ],
      }),
    ]);
    expect(changes.state).toBe('partial');
    expect(notes(changes)).toEqual(["Couldn't commit the changes of 1 turn."]);
  });

  it('says a shell may have changed files nobody recorded, never None', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [{ state: 'nothing', run_id: 'run-s', shell_unrecorded: true }],
      }),
    ]);
    expect(changes.state).toBe('partial');
    expect(notes(changes)).toEqual([
      "Shell commands in 1 turn may have changed other files; those aren't recorded here.",
    ]);
  });

  it('notes the files added and then deleted, which no row lists', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [
          committed(['d1.md', 'd2.md', 'd3.md', 'd4.md', 'keep.md'].map((p) => file(p, 'added'))),
        ],
      }),
      asked('u-2'),
      replied('a-2', {
        changesets: [
          committed(['d1.md', 'd2.md', 'd3.md', 'd4.md'].map((p) => file(p, 'deleted'))),
        ],
      }),
    ]);
    expect(rows(changes)).toEqual(['keep.md: added · +1 −0']);
    expect(notes(changes)).toEqual(['Added and then deleted: d1.md, d2.md, d3.md and 1 more.']);
  });
});

describe('each row', () => {
  it('opens its page outside the canvas, a deleted file its diff at the commit that deleted it', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [
          committed([file('gone.md', 'deleted', 0, 4), file('kept.md', 'modified')], {
            commit: 'ddddddd',
          }),
        ],
      }),
    ]);
    expect(changes.others.map((row) => row.open)).toEqual([
      { kind: 'diff', path: 'gone.md', commit: 'ddddddd' },
      { kind: 'page', path: 'kept.md' },
    ]);
  });

  it('opens nothing outside the vault', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', { changesets: [committed([file('../outside.md', 'modified')])] }),
    ]);
    expect(changes.others[0].open).toBeNull();
  });

  it('keys each row by its kind and path, and names who else wrote it', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [committed([file('a.md', 'modified', 1, 0, { also_by: ['human:me'] })])],
      }),
    ]);
    expect(changes.others[0]).toMatchObject({ key: 'modified:a.md', alsoBy: ['human:me'] });
  });
});

describe('pull requests', () => {
  const pr = (number: number, url = `https://github.com/acme/notes/pull/${number}`): PrLink => ({
    number,
    url,
    repository: 'acme/notes',
  });

  it('come after the files, once each; alone, they are something to show', () => {
    const changes = changesOf([], {
      prLinks: [pr(42), pr(42, 'https://github.com/Acme/Notes/pull/42/files'), pr(7)],
    });
    expect(changes.pullRequests).toEqual([
      {
        key: 'https://github.com/acme/notes/pull/42',
        url: 'https://github.com/acme/notes/pull/42',
        name: 'acme/notes#42',
      },
      {
        key: 'https://github.com/acme/notes/pull/7',
        url: 'https://github.com/acme/notes/pull/7',
        name: 'acme/notes#7',
      },
    ]);
    expect(changes).toMatchObject({ state: 'ready', count: '2 pull requests' });
  });

  const read = (over: Partial<PullRequest>): PrRead => ({
    state: 'read',
    checkedAt: '2026-10-14T12:00:00Z',
    pr: {
      number: 42,
      url: 'https://github.com/acme/notes/pull/42',
      title: 'Tidy',
      state: 'OPEN',
      isDraft: false,
      mergedAt: null,
      closedAt: null,
      headRefName: 'tidy',
      baseRefName: 'main',
      author: 'me',
      body: null,
      reviewDecision: null,
      mergeStateStatus: null,
      updatedAt: null,
      checks: [],
      ...over,
    },
  });

  it.each<[string, PrRead | null, string]>([
    ['still reading', null, 'reading…'],
    ['merged', read({ state: 'MERGED' }), 'merged'],
    ['closed', read({ state: 'CLOSED' }), 'closed'],
    ['a draft', read({ isDraft: true }), 'draft'],
    ['open, no checks', read({}), 'open · no checks'],
    [
      'open, checks passed',
      read({
        checks: [{ kind: 'check_run', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      }),
      'open · ready',
    ],
    ['open, no rollup', read({ checks: null }), 'open · checks unknown'],
    [
      'a failed read',
      { state: 'gh_missing', checkedAt: '2026-10-14T12:00:00Z' },
      "state unavailable: gh isn't installed",
    ],
  ])('words the state forge.rs read: %s', (_, state, words) => {
    expect(pullRequestWords(state)).toBe(words);
  });
});

describe('the same card while nothing it reads changes', () => {
  it('hands the rail one object across a turn’s stream, and a new one when a run’s changes land', () => {
    const first = committed([file('a.md', 'added')]);
    let messages: ChatMessage[] = [
      asked('u-1'),
      replied('a-1', { changesets: [first] }),
      asked('u-2'),
      replied('a-2', { streaming: true, text: '' }),
    ];
    const prLinks: PrLink[] = [];
    const input = () => ({ messages, inFlight: true, sessionId: 's-own', prLinks });
    const before = railChanges(input());
    for (let delta = 0; delta < 50; delta += 1) {
      // Every TextDelta makes a new message and a new list (transcript.ts).
      messages = messages.map((m) => (m.id === 'a-2' ? { ...m, text: `${m.text}word ` } : m));
      expect(railChanges(input())).toBe(before);
    }
    messages = messages.map((m) =>
      m.id === 'a-2' ? { ...m, changesets: [committed([file('b.md', 'added')])] } : m,
    );
    const landed = railChanges(input());
    expect(landed).not.toBe(before);
    expect(rows(landed)).toEqual(['a.md: added · +1 −0', 'b.md: added · +1 −0']);
  });

  it('makes a new one when the turn ends, a heal answers or a pull request opens', () => {
    const messages = [
      asked('u-1'),
      replied('a-1', { changesets: [committed([file('a.md', 'added')])] }),
    ];
    const prLinks: PrLink[] = [];
    const running = railChanges({ messages, inFlight: true, sessionId: 's-own', prLinks });
    const ended = railChanges({ messages, inFlight: false, sessionId: 's-own', prLinks });
    expect(ended).not.toBe(running);
    const healed = railChanges({
      messages,
      inFlight: false,
      sessionId: 's-own',
      prLinks,
      heal: { state: 'unavailable' },
    });
    expect(healed).not.toBe(ended);
    // The same answer again, in a new object, is the same card.
    expect(
      railChanges({
        messages,
        inFlight: false,
        sessionId: 's-own',
        prLinks,
        heal: { state: 'unavailable' },
      }),
    ).toBe(healed);
    const opened = railChanges({
      messages,
      inFlight: false,
      sessionId: 's-own',
      prLinks: [
        { number: 1, url: 'https://github.com/acme/notes/pull/1', repository: 'acme/notes' },
      ],
    });
    expect(opened).not.toBe(healed);
  });
});

describe('the heal’s answer, by content (M92.12)', () => {
  /** One read of the heal: each hands back new objects, as they crossed
   *  IPC. */
  const answer = (additions: number, truncated?: boolean): ChangesHeal => ({
    state: 'read',
    changesets: [
      committed([file('a.md', 'modified', additions, 0, { also_by: null })], {
        run_id: 'run-h',
        commit: 'abcdef1',
      }),
    ],
    ...(truncated === undefined ? {} : { truncated }),
  });

  it('hands back the same card for a read that says what the last one said', () => {
    const messages = [asked('u-1'), replied('a-1')];
    const prLinks: PrLink[] = [];
    const cardFor = (heal: ChangesHeal) =>
      railChanges({ messages, inFlight: false, sessionId: 's-own', prLinks, heal });
    const first = cardFor(answer(2, false));
    expect(rows(first)).toEqual(['a.md: modified · +2 −0']);
    expect(first.others[0].alsoBy).toBeNull();
    expect(cardFor(answer(2, false))).toBe(first);
    // Not cut is not cut, said or left unsaid.
    expect(cardFor(answer(2))).toBe(first);
    const counted = cardFor(answer(3));
    expect(counted).not.toBe(first);
    expect(rows(counted)).toEqual(['a.md: modified · +3 −0']);
    const cut = cardFor(answer(3, true));
    expect(cut).not.toBe(counted);
    expect(cut.state).toBe('partial');
    expect(cardFor({ state: 'unavailable' })).not.toBe(cut);
  });
});

describe('runOfCommit', () => {
  it('names the run whose commit a diff opens at, for the notes left on its lines', () => {
    const changes = changesOf([
      asked('u-1'),
      replied('a-1', {
        changesets: [committed([file('a.md', 'added')], { run_id: 'run-a', commit: 'abcdef1' })],
      }),
    ]);
    expect(runOfCommit(changes, 'abcdef1')).toBe('run-a');
    expect(runOfCommit(changes, '1234567')).toBeNull();
  });
});
