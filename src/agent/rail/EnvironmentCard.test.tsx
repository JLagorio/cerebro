// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitRemoteStatus } from '@/engine/git';

vi.mock('@/lib/gitIpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitIpc')>();
  return {
    ...actual,
    isGitRepo: vi.fn(async () => true),
    getModifiedFiles: vi.fn(async () => []),
    getConflictFiles: vi.fn(async () => []),
    getConflictMode: vi.fn(async () => 'none' as const),
    gitRemoteStatus: vi.fn(),
  };
});

import { RAIL_ENVIRONMENT_WORDS } from '@/agent/elements/railEnvironment';
import type { RunReach } from '@/agent/types';
import { makeEntry } from '@/engine/testHelpers';
import { UNCOUNTED_WORDS } from '@/engine/git';
import { resetGitState } from '@/git/useGit';
import * as gitIpc from '@/lib/gitIpc';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { EnvironmentCard, type EnvironmentCardProps } from './EnvironmentCard';

/**
 * The rail's Environment card (M92.9): the vault, its history and sync as
 * the shell says them (`useGit`), who answers in the panel, and what the
 * conversation's latest run reaches. A failed git read is unavailable,
 * never a vault with no history; folded, it reads and watches nothing.
 */

const VAULT = '/Users/ana/demo-vault';

const COUNTED: GitRemoteStatus = {
  branch: 'main',
  ahead: 2,
  behind: 0,
  hasRemote: true,
  hasUpstream: true,
  upstream: 'origin/main',
};

const REACH: RunReach = {
  connectors: [],
  missing: [],
  missing_more: 0,
  inherits: false,
  permission_mode: 'default',
  cerebro: true,
  families: {
    confirmable: ['ask'],
    shell: ['ask'],
    web: ['allow'],
    delegate: ['cli'],
    file_write: ['ask'],
  },
};

const SCOUT = makeEntry({
  path: 'records/agents/release-scout.md',
  title: 'Release scout',
  type: 'Agent',
});

function Card(props: Partial<EnvironmentCardProps>) {
  return <EnvironmentCard vault={VAULT} reach={REACH} folded={false} {...props} />;
}

const card = () => screen.getByTestId('rail-environment');
const value = (key: string) =>
  within(card()).getByTestId(`rail-environment-${key}`).querySelector('.cb-rail-environment-value')
    ?.textContent;

/** Let every read a render started land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(gitIpc.isGitRepo).mockResolvedValue(true);
  vi.mocked(gitIpc.gitRemoteStatus).mockResolvedValue(COUNTED);
  resetGitState();
  useVaultStore.setState({ vaultPath: VAULT, entries: [SCOUT] });
  useUiStore.setState({ panelAgents: { [VAULT]: null }, panelAgentsUnreadable: {} });
});

afterEach(() => {
  cleanup();
  resetGitState();
});

describe('what the card says', () => {
  it('names the vault, its branch and sync, who answers, and what the run reaches', async () => {
    render(<Card />);
    await settle();
    expect(card().dataset.state).toBe('ready');
    expect(within(card()).getByRole('heading', { level: 3 }).textContent).toBe('Environmentmain');
    expect(value('vault')).toBe('demo-vault');
    expect(value('history')).toBe('main');
    expect(value('sync')).toBe('2 to push');
    expect(value('answers')).toBe(RAIL_ENVIRONMENT_WORDS.assistant);
    expect(value('pages')).toBe('Asks before writing');
    expect(value('shell')).toBe('Asks first');
    expect(value('web')).toBe('On');
    expect(value('subagents')).toBe('On');
    expect(value('edits')).toBe('Asks before each edit');
    expect(card().querySelector('a[href]')).toBeNull();
  });

  it('names the agent the panel answers as', async () => {
    useUiStore.setState({ panelAgents: { [VAULT]: 'release-scout' } });
    render(<Card />);
    await settle();
    expect(value('answers')).toBe('Release scout');
  });

  it('says History off for a vault with no history', async () => {
    vi.mocked(gitIpc.isGitRepo).mockResolvedValue(false);
    render(<Card />);
    await settle();
    expect(card().dataset.state).toBe('ready');
    expect(within(card()).getByTestId('rail-environment-history').dataset.state).toBe('off');
    expect(value('history')).toBe(RAIL_ENVIRONMENT_WORDS.historyOff);
    expect(within(card()).queryByTestId('rail-environment-sync')).toBeNull();
  });

  it('is unavailable when the git read fails, never History off', async () => {
    vi.mocked(gitIpc.isGitRepo).mockRejectedValue(new Error('git is not on this PATH'));
    render(<Card />);
    await settle();
    expect(card().dataset.state).toBe('unavailable');
    const unavailable = within(card()).getByTestId('section-unavailable');
    expect(unavailable.textContent).toContain(RAIL_ENVIRONMENT_WORDS.unavailable);
    expect(unavailable.textContent).toContain('git is not on this PATH');
    expect(card().textContent).not.toContain(RAIL_ENVIRONMENT_WORDS.historyOff);
    expect(within(card()).queryByTestId('rail-environment-history')).toBeNull();
    // What it can still say, it says.
    expect(value('vault')).toBe('demo-vault');
    expect(value('pages')).toBe('Asks before writing');
  });

  it('never says Up to date for counts git could not take', async () => {
    vi.mocked(gitIpc.gitRemoteStatus).mockResolvedValue({ ...COUNTED, ahead: null, behind: null });
    render(<Card />);
    await settle();
    expect(card().dataset.state).toBe('partial');
    expect(value('sync')).toBe('Sync unknown');
    expect(within(card()).getByTestId('rail-environment-sync').querySelector('dd')?.title).toBe(
      UNCOUNTED_WORDS.unread,
    );
    expect(card().textContent).not.toContain('Up to date');
    expect(card().textContent).toContain(UNCOUNTED_WORDS.unread);
  });

  it('says why sync is unknown in text, not a title alone', async () => {
    vi.mocked(gitIpc.gitRemoteStatus).mockResolvedValue({
      ...COUNTED,
      ahead: null,
      behind: null,
      hasUpstream: false,
      upstream: null,
    });
    render(<Card />);
    await settle();
    expect(value('sync')).toBe('Sync unknown');
    const dd = within(card()).getByTestId('rail-environment-sync').querySelector('dd');
    expect(dd?.querySelector('.sr-only')?.textContent).toContain(UNCOUNTED_WORDS.no_upstream);
  });

  it('is not recorded before a turn said what the conversation reaches', async () => {
    render(<Card reach={null} />);
    await settle();
    expect(card().dataset.state).toBe('not-recorded');
    expect(screen.getByTestId('rail-environment-reach-not-recorded').textContent).toContain(
      RAIL_ENVIRONMENT_WORDS.reachNotRecorded,
    );
    expect(within(card()).queryByTestId('rail-environment-pages')).toBeNull();
    expect(value('history')).toBe('main');
  });

  it('claims nothing until git has answered', async () => {
    vi.mocked(gitIpc.isGitRepo).mockReturnValue(new Promise(() => undefined));
    render(<Card />);
    await settle();
    expect(screen.queryByTestId('rail-environment')).toBeNull();
  });
});

describe('the reading rules', () => {
  it('never reads while folded, and reads as the rail unfolds', async () => {
    const view = render(<Card folded />);
    await settle();
    expect(gitIpc.isGitRepo).not.toHaveBeenCalled();
    expect(screen.queryByTestId('rail-environment')).toBeNull();
    view.rerender(<Card folded={false} />);
    await settle();
    expect(gitIpc.isGitRepo).toHaveBeenCalledTimes(1);
    expect(card().dataset.state).toBe('ready');
  });

  it('starts no poll of its own while folded', async () => {
    vi.useFakeTimers();
    try {
      const view = render(<Card />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(gitIpc.isGitRepo).toHaveBeenCalledTimes(1);
      view.rerender(<Card folded />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000 * 3);
      });
      expect(gitIpc.isGitRepo).toHaveBeenCalledTimes(1);
      expect(card().dataset.state).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });
});
