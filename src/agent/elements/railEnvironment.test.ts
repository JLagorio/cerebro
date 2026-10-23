import { describe, expect, it } from 'vitest';
import type { RunReach } from '@/agent/types';
import { makeEntry } from '@/engine/testHelpers';
import { syncState, UNCOUNTED_WORDS, type GitRemoteStatus } from '@/engine/git';
import { SYNC_TONE } from '@/git/SyncBadge';
import { TOOL_APPROVAL, type Decision } from '@/lib/policy/toolApproval';
import {
  answersAs,
  RAIL_ENVIRONMENT_WORDS,
  railEnvironment,
  REACH_FAMILIES,
  reached,
  type RailEnvironmentInput,
} from './railEnvironment';

/**
 * The rail's Environment card (M92.9): the vault, its history and sync as
 * the shell says them, who answers in the panel, and what the run reaches.
 */

const COUNTED: GitRemoteStatus = {
  branch: 'main',
  ahead: 2,
  behind: 0,
  hasRemote: true,
  hasUpstream: true,
  upstream: 'origin/main',
};

type Git = RailEnvironmentInput['git'];

/** A shared git state as `useGit` hands it over, its sync derived. */
function gitOf(over: Partial<Git> = {}): Git {
  const base: Git = {
    ready: true,
    isRepo: true,
    readError: null,
    branch: 'main',
    remote: null,
    sync: 'clean',
    modified: [],
    conflicts: [],
    ...over,
  };
  return { ...base, sync: syncState(base.remote, base.modified.length, base.conflicts.length) };
}

/** What a watched run with Settings' defaults reaches: Cerebro's tools, the
 *  shell and the web off, subagents on, Claude Code's own edits off. */
function reachOf(
  families: Record<string, Decision[]> = {},
  over: Partial<RunReach> = {},
): RunReach {
  return {
    connectors: [],
    missing: [],
    missing_more: 0,
    inherits: false,
    permission_mode: 'acceptEdits',
    cerebro: true,
    families: {
      confirmable: ['allow'],
      shell: ['deny'],
      web: ['deny'],
      delegate: ['cli'],
      file_write: ['deny'],
      ...families,
    },
    ...over,
  };
}

function input(over: Partial<RailEnvironmentInput> = {}): RailEnvironmentInput {
  return {
    vault: '/Users/ana/notes',
    git: gitOf(),
    answers: { state: 'assistant' },
    reach: reachOf(),
    ...over,
  };
}

/** The card's lines as [key, value, state]. */
const lines = (over: Partial<RailEnvironmentInput> = {}) =>
  railEnvironment(input(over)).lines.map((line) => [line.key, line.value, line.state]);

describe('railEnvironment', () => {
  it('names the vault, its branch, its sync, who answers and what the run reaches', () => {
    const view = railEnvironment(input({ git: gitOf({ remote: COUNTED }) }));
    expect(view.state).toBe('ready');
    expect(view.count).toBe('main');
    expect(view.lines.map((line) => [line.key, line.term, line.value])).toEqual([
      ['vault', 'Vault', 'notes'],
      ['history', 'History', 'main'],
      ['sync', 'Sync', '2 to push'],
      ['answers', 'Answers as', 'Assistant'],
      ['pages', 'Pages', 'Reads and writes'],
      ['shell', 'Shell', 'Off'],
      ['web', 'Web', 'Off'],
      ['subagents', 'Subagents', 'On'],
      ['edits', 'Edit mode', 'Off'],
    ]);
    expect(view.lines[0].detail).toBe('/Users/ana/notes');
    expect(view.lines[2].icon).toEqual({
      name: SYNC_TONE.ahead.icon,
      color: SYNC_TONE.ahead.color,
    });
  });

  it('says the SyncBadge’s words for every state', () => {
    const changed = gitOf({
      remote: COUNTED,
      modified: [{ path: 'a.md', status: 'modified', staged: false }],
    });
    expect(lines({ git: changed })[2]).toEqual(['sync', '1 uncommitted', 'local-changes']);
    const conflicted = gitOf({ remote: COUNTED, conflicts: ['a.md'] });
    expect(lines({ git: conflicted })[2]).toEqual(['sync', '1 conflicted', 'conflict']);
    const behind = gitOf({ remote: { ...COUNTED, ahead: 0, behind: 3 } });
    expect(lines({ git: behind })[2]).toEqual(['sync', '3 to pull', 'behind']);
    const even = gitOf({ remote: { ...COUNTED, ahead: 0 } });
    expect(lines({ git: even })[2]).toEqual(['sync', 'Up to date', 'clean']);
  });

  it('says No remote for a repository with nothing to sync with', () => {
    expect(lines()[2]).toEqual(['sync', RAIL_ENVIRONMENT_WORDS.noRemote, 'local']);
  });

  it('says History off for a vault with no history, never a branch', () => {
    const view = railEnvironment(input({ git: gitOf({ isRepo: false, branch: null }) }));
    expect(view.state).toBe('ready');
    expect(view.count).toBe(RAIL_ENVIRONMENT_WORDS.historyOff);
    expect(view.lines.map((line) => line.key)).not.toContain('sync');
    expect(view.lines[1]).toMatchObject({ key: 'history', value: 'History off', state: 'off' });
  });

  it('is unavailable when the git read failed, never a vault with no history', () => {
    for (const isRepo of [null, true, false]) {
      const view = railEnvironment(
        input({ git: gitOf({ isRepo, readError: 'git is not on this PATH' }) }),
      );
      expect(view.state).toBe('unavailable');
      expect(view.reason).toBe('git is not on this PATH');
      expect(view.lines.map((line) => line.key)).not.toContain('history');
      expect(view.lines.map((line) => line.key)).not.toContain('sync');
      expect(JSON.stringify(view)).not.toContain(RAIL_ENVIRONMENT_WORDS.historyOff);
    }
  });

  it('never says Up to date for counts git could not take', () => {
    const unread = gitOf({ remote: { ...COUNTED, ahead: null, behind: null } });
    const view = railEnvironment(input({ git: unread }));
    expect(view.state).toBe('partial');
    expect(view.notes).toEqual([UNCOUNTED_WORDS.unread]);
    expect(view.lines[2]).toMatchObject({
      value: 'Sync unknown',
      state: 'unknown',
      detail: UNCOUNTED_WORDS.unread,
    });
    expect(JSON.stringify(view)).not.toContain('Up to date');
    // A branch with no upstream has nothing to count against: known, not partial.
    const untracked = gitOf({
      remote: { ...COUNTED, ahead: null, behind: null, hasUpstream: false, upstream: null },
    });
    const topic = railEnvironment(input({ git: untracked }));
    expect(topic.state).toBe('ready');
    expect(topic.lines[2]).toMatchObject({
      value: 'Sync unknown',
      detail: UNCOUNTED_WORDS.no_upstream,
    });
  });

  it('is not recorded before any run said what the conversation reaches', () => {
    const view = railEnvironment(input({ reach: null }));
    expect(view.state).toBe('not-recorded');
    expect(view.reachNotRecorded).toBe(true);
    expect(view.lines.map((line) => line.key)).toEqual(['vault', 'history', 'sync', 'answers']);
  });

  it('makes no claim until git has answered, and is empty with no vault', () => {
    expect(railEnvironment(input({ git: gitOf({ ready: false, isRepo: null }) })).state).toBeNull();
    expect(railEnvironment(input({ vault: null })).state).toBe('empty');
  });

  it('says who answers in the panel', () => {
    const answers = (over: RailEnvironmentInput['answers']) =>
      railEnvironment(input({ answers: over })).lines.find((line) => line.key === 'answers');
    expect(answers({ state: 'agent', title: 'Release scout' })?.value).toBe('Release scout');
    expect(answers({ state: 'missing', handle: 'gone' })?.value).toBe('@gone not found');
    expect(answers({ state: 'reading' })).toBeUndefined();
    const unreadable = railEnvironment(input({ answers: { state: 'unreadable' } }));
    expect(unreadable.state).toBe('partial');
    expect(unreadable.notes).toEqual([RAIL_ENVIRONMENT_WORDS.partialBinding]);
  });

  it('words each reach by its family’s decisions', () => {
    const value = (key: string, reach: RunReach) =>
      railEnvironment(input({ reach })).lines.find((line) => line.key === key)?.value;
    expect(value('pages', reachOf({}, { cerebro: false }))).toBe('Not reached');
    expect(value('pages', reachOf({ confirmable: ['ask'] }))).toBe('Asks before writing');
    expect(value('pages', reachOf({ confirmable: ['queue'] }))).toBe('Writes wait for Review');
    expect(value('pages', reachOf({ confirmable: ['deny'] }))).toBe('Page writes off');
    expect(value('shell', reachOf({ shell: ['ask'] }))).toBe('Asks first');
    expect(value('shell', reachOf({ shell: ['allow'] }))).toBe('On');
    expect(value('shell', reachOf({ shell: ['allow', 'deny'] }))).toBe('Partly');
    expect(value('web', reachOf({ web: ['allow'] }))).toBe('On');
    expect(value('subagents', reachOf({ delegate: ['deny'] }))).toBe('Off');
    expect(value('edits', reachOf({ file_write: ['allow'] }))).toBe('Accepts edits');
    expect(value('edits', reachOf({ file_write: ['allow'] }, { permission_mode: 'default' }))).toBe(
      'On',
    );
    expect(value('edits', reachOf({ file_write: ['ask'] }))).toBe('Asks before each edit');
    // A family the plan named nothing for is not recorded, never off.
    expect(value('web', reachOf({ web: [] }))).toBe(RAIL_ENVIRONMENT_WORDS.notRecorded);
  });

  it('reads each family the tool-approval table holds', () => {
    const families = TOOL_APPROVAL.families.map((family) => family.id);
    for (const family of REACH_FAMILIES) expect(families).toContain(family);
    expect(REACH_FAMILIES).toContain(TOOL_APPROVAL.ask_first.family);
  });
});

describe('reached', () => {
  it('reads a family’s decisions together', () => {
    expect(reached(undefined)).toBeNull();
    expect(reached([])).toBeNull();
    expect(reached(['allow', 'cli'])).toBe('on');
    expect(reached(['ask', 'allow'])).toBe('asks');
    expect(reached(['queue'])).toBe('queues');
    expect(reached(['deny', 'refuse'])).toBe('off');
    expect(reached(['allow', 'deny'])).toBe('some');
  });
});

describe('answersAs', () => {
  const SCOUT = makeEntry({
    path: 'records/agents/release-scout.md',
    title: 'Release scout',
    type: 'Agent',
  });

  it('reads the panel’s binding by the vault’s agents', () => {
    expect(answersAs(undefined, false, [SCOUT])).toEqual({ state: 'reading' });
    expect(answersAs(null, false, [SCOUT])).toEqual({ state: 'assistant' });
    expect(answersAs('release-scout', false, [SCOUT])).toEqual({
      state: 'agent',
      title: 'Release scout',
    });
    expect(answersAs('gone', false, [SCOUT])).toEqual({ state: 'missing', handle: 'gone' });
    expect(answersAs('release-scout', true, [SCOUT])).toEqual({ state: 'unreadable' });
  });
});
