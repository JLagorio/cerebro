// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROUP_ROWS,
  railChanges,
  type ChangesHeal,
  type RailChangesInput,
} from '@/agent/elements/conversationChanges';
import { pullRequestSources } from '@/agent/elements/panelSources';
import { TurnChangeset } from '@/agent/TurnChangeset';
import type { ChatMessage, PrLink } from '@/agent/types';
import { Sources } from '@/components/ai/Sources';
import type { ChangedFile, ChangeKind, RunChangeset } from '@/engine/changeset';
import type { PrRead } from '@/engine/pullRequest';
import * as gitIpc from '@/lib/gitIpc';
import { seedPullRequests } from '@/lib/mockGit';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ChangesCard, type ChangesCardProps } from './ChangesCard';

/**
 * The rail's Changes card (M92.5): what the conversation changed, in the
 * canvas beside its transcript. A row's first action stays in the canvas and
 * shows the change where its turn's changeset lists it; its second floats the
 * conversation before it opens a page, which the canvas would hide. Nothing
 * in it is an href (CV-16), and nothing it cannot count reads as zero
 * (CV-05).
 */

const FIRST = '1111111111111111111111111111111111111111';
const SECOND = '2222222222222222222222222222222222222222';

const file = (
  path: string,
  kind: ChangeKind,
  additions: number | null = 1,
  deletions: number | null = 0,
  over: Partial<ChangedFile> = {},
): ChangedFile => ({ path, previous_path: null, kind, additions, deletions, also_by: [], ...over });

const committed = (run: string, commit: string, files: ChangedFile[]): RunChangeset => ({
  state: 'committed',
  run_id: run,
  commit,
  files,
  additions: null,
  deletions: null,
  binary: 0,
  shell_unrecorded: false,
});

const asked = (id: string): ChatMessage => ({ id, role: 'user', text: 'Tidy notes', tools: [] });
const replied = (id: string, changesets?: RunChangeset[], over: Partial<ChatMessage> = {}) =>
  ({
    id,
    role: 'assistant',
    text: 'Done.',
    tools: [],
    ...(changesets === undefined ? {} : { changesets }),
    ...over,
  }) satisfies ChatMessage;

/** Two turns: the first adds a page and edits another, the second deletes a
 *  third and edits the second again. */
const TIDY: ChatMessage[] = [
  asked('u-1'),
  replied('a-1', [
    committed('run-1', FIRST, [
      file('notes/new.md', 'added', 3, 0),
      file('notes/old.md', 'modified', 2, 1, { also_by: ['human:me'] }),
    ]),
  ]),
  asked('u-2'),
  replied('a-2', [
    committed('run-2', SECOND, [
      file('notes/gone.md', 'deleted', 0, 4),
      file('notes/old.md', 'modified', 1, 1),
    ]),
  ]),
];

const PR_URL = 'https://github.com/acme/notes/pull/42';
const PR: PrLink = { number: 42, url: PR_URL, repository: 'acme/notes' };

const jump = vi.fn((go: () => void) => go());
const onOpenPath = vi.fn();
const onViewDiff = vi.fn();

type PanelProps = Partial<ChangesCardProps> &
  Partial<Omit<RailChangesInput, 'messages'>> & { messages: ChatMessage[] };

/** The panel's aside as the canvas draws it: the transcript, each reply's
 *  changeset under it in its row (MessageScrollerItem's `data-message-id`),
 *  the thread's pull requests under them, and the rail's card beside them. */
function Panel({
  messages,
  inFlight = false,
  sessionId = 's-own',
  prLinks = [],
  heal,
  ...card
}: PanelProps) {
  const changes = railChanges({ messages, inFlight, sessionId, prLinks, heal });
  return (
    <aside aria-label="AI panel">
      <div data-testid="transcript">
        {messages.map((message) => (
          <div key={message.id} data-message-id={message.id}>
            {message.changesets !== undefined && (
              <TurnChangeset
                changesets={message.changesets}
                onOpenPath={() => {}}
                onViewDiff={() => {}}
              />
            )}
          </div>
        ))}
        {prLinks.length > 0 && (
          <Sources
            data-testid="thread-pr-links"
            sources={pullRequestSources(prLinks)}
            defaultOpen
          />
        )}
      </div>
      <ChangesCard
        changes={changes}
        folded={false}
        jump={jump}
        onOpenPath={onOpenPath}
        onViewDiff={onViewDiff}
        {...card}
      />
    </aside>
  );
}

const card = () => screen.getByTestId('rail-changes');
const row = (path: string) =>
  within(card())
    .getAllByTestId('rail-change')
    .find((el) => el.dataset.path === path) as HTMLElement;
/** A reply's row in the transcript. */
const reply = (id: string) => document.querySelector(`[data-message-id="${id}"]`) as HTMLElement;
const presentation = () => useUiStore.getState().aiPanelPresentation;

beforeEach(() => {
  jump.mockClear();
  onOpenPath.mockReset();
  onViewDiff.mockReset();
  seedPullRequests({});
  useVaultStore.setState({ vaultPath: '/v', entries: [] });
  useUiStore.setState({ aiPanelPresentation: 'canvas', aiPanelMinimized: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('what the card says', () => {
  it('draws a conversation that changed nothing as one quiet line ending in None', () => {
    render(<Panel messages={[]} />);
    expect(card().dataset.state).toBe('empty');
    expect(within(card()).getByRole('heading', { level: 3 }).textContent).toBe('ChangesNone');
    expect(within(card()).queryByRole('button')).toBeNull();
  });

  it('while a turn works and nothing has landed, its line reads “Changes land when this turn ends”', () => {
    render(
      <Panel messages={[asked('u-1'), replied('a-1', undefined, { streaming: true })]} inFlight />,
    );
    expect(card().dataset.state).toBe('empty');
    expect(card().dataset.pending).toBe('true');
    expect(within(card()).getByRole('heading', { level: 3 }).textContent).toBe(
      'Changes land when this turn ends',
    );
  });

  it('says the same beside what earlier turns changed', () => {
    render(
      <Panel
        messages={[...TIDY, asked('u-3'), replied('a-3', undefined, { streaming: true })]}
        inFlight
      />,
    );
    expect(card().dataset.state).toBe('ready');
    expect(card().textContent).toContain('Changes land when this turn ends.');
  });

  it('says how many turns nobody recorded, never None', () => {
    render(<Panel messages={[asked('u-1'), replied('a-1'), asked('u-2'), replied('a-2')]} />);
    expect(card().dataset.state).toBe('not-recorded');
    expect(card().textContent).toContain('Changes not recorded for 2 turns.');
    expect(card().textContent).not.toContain('None');
  });

  it('lists the added files first, then the rest, summed across the turns', () => {
    render(<Panel messages={TIDY} />);
    expect(card().dataset.state).toBe('ready');
    expect(within(card()).getByRole('button', { name: 'Changes 3 files' })).toBeTruthy();
    expect(screen.getByTestId('rail-changes-summary').textContent).toBe('+6 −6 across 2 turns');
    const added = within(card()).getByRole('group', { name: 'Added · 1' });
    expect(
      within(added)
        .getAllByTestId('rail-change')
        .map((el) => el.dataset.path),
    ).toEqual(['notes/new.md']);
    const changed = within(card()).getByRole('group', { name: 'Changed · 2' });
    expect(
      within(changed)
        .getAllByTestId('rail-change')
        .map((el) => el.dataset.path),
    ).toEqual(['notes/gone.md', 'notes/old.md']);
    expect(row('notes/old.md').textContent).toContain('notes · modified · +3 −2');
    expect(row('notes/old.md').textContent).toContain('also edited by you');
    expect(row('notes/gone.md').dataset.kind).toBe('deleted');
  });

  it('never says “+0 −0”', () => {
    render(
      <Panel
        messages={[
          asked('u-1'),
          replied('a-1', [
            committed('run-1', FIRST, [
              file('b.md', 'renamed', 0, 0, { previous_path: 'a.md' }),
              file('logo.png', 'modified', null, null),
            ]),
          ]),
        ]}
      />,
    );
    expect(card().textContent).not.toContain('+0 −0');
    expect(row('b.md').textContent).toContain('renamed · no line changes');
    expect(row('b.md').textContent).toContain('from a.md');
    expect(row('logo.png').textContent).toContain('modified · binary');
  });

  it('marks a failed read back of earlier changes unavailable, never empty', () => {
    const heal: ChangesHeal = { state: 'unavailable' };
    render(<Panel messages={TIDY} heal={heal} />);
    expect(card().dataset.state).toBe('unavailable');
    expect(within(card()).getByTestId('section-unavailable').textContent).toBe(
      "Couldn't read back this conversation's earlier changes.",
    );
  });

  it('shows every row a press away past the first few', () => {
    const many = Array.from({ length: GROUP_ROWS + 2 }, (_, i) => file(`p${i}.md`, 'added'));
    render(<Panel messages={[asked('u-1'), replied('a-1', [committed('run-1', FIRST, many)])]} />);
    expect(within(card()).getAllByTestId('rail-change')).toHaveLength(GROUP_ROWS);
    const more = within(card()).getByRole('button', { name: `Show all ${GROUP_ROWS + 2}` });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(card()).getAllByTestId('rail-change')).toHaveLength(GROUP_ROWS + 2);
    expect(within(card()).getByRole('button', { name: 'Show fewer' })).toBe(more);
  });
});

describe('every control', () => {
  it('is a button and a tab stop of its own, never an href (CV-16)', async () => {
    render(<Panel messages={TIDY} prLinks={[PR]} />);
    await screen.findByText("state unavailable: gh isn't installed");
    expect(card().querySelector('a[href]')).toBeNull();
    const buttons = within(card()).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(4);
    for (const button of buttons) expect(button.getAttribute('tabindex')).toBe('0');
  });
});

describe('a row’s first action', () => {
  it('shows the change in its turn’s changeset, and stays in the canvas', () => {
    render(<Panel messages={TIDY} />);
    fireEvent.click(
      within(row('notes/old.md')).getByRole('button', { name: /^Jump to where old\.md changed/ }),
    );
    expect(jump).toHaveBeenCalledTimes(1);
    // The latest turn that changed it: its File Tree row's own button.
    const target = reply('a-2').querySelector(
      '[data-slot="file-tree-file"][data-path="notes/old.md"] button',
    );
    expect(target).not.toBeNull();
    expect(document.activeElement).toBe(target);
    expect(presentation()).toBe('canvas');
    expect(onOpenPath).not.toHaveBeenCalled();
  });

  it('lands a deleted file on the first control its row keeps', () => {
    render(<Panel messages={TIDY} />);
    fireEvent.click(
      within(row('notes/gone.md')).getByRole('button', { name: /^Jump to where gone\.md changed/ }),
    );
    expect(document.activeElement).toBe(
      within(reply('a-2')).getByRole('button', { name: 'Show the changes to notes/gone.md' }),
    );
  });

  it('lands on the changeset where the reader folded the file away', () => {
    render(<Panel messages={TIDY} />);
    const folder = reply('a-2').querySelector('[data-slot="file-tree-folder"] button')!;
    fireEvent.click(folder);
    expect(folder.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(
      within(row('notes/old.md')).getByRole('button', { name: /^Jump to where old\.md changed/ }),
    );
    const focused = document.activeElement as HTMLElement;
    expect(reply('a-2').contains(focused)).toBe(true);
    expect(focused.closest('[hidden]')).toBeNull();
  });

  it('lets the host’s transcript scroller bring the change into view', () => {
    const reveal = vi.fn();
    render(<Panel messages={TIDY} reveal={reveal} />);
    fireEvent.click(
      within(row('notes/new.md')).getByRole('button', { name: /^Jump to where new\.md changed/ }),
    );
    expect(reveal).toHaveBeenCalledWith(
      reply('a-1').querySelector('[data-slot="file-tree-file"][data-path="notes/new.md"]'),
    );
  });

  it('shows a file no commit carried where its turn lists it', () => {
    const unrecorded: RunChangeset = {
      state: 'not_a_repo',
      run_id: 'run-h',
      files: ['loose.md'],
      shell_unrecorded: false,
    };
    render(<Panel messages={[asked('u-1'), replied('a-1', [unrecorded])]} />);
    expect(row('loose.md').textContent).toContain('not committed');
    fireEvent.click(
      within(row('loose.md')).getByRole('button', { name: /^Jump to where loose\.md changed/ }),
    );
    expect(document.activeElement).toBe(
      within(reply('a-1')).getByRole('button', { name: 'loose.md' }),
    );
  });

  it('has nowhere to show a run only the heal read back, and still opens its page', () => {
    const heal: ChangesHeal = {
      state: 'read',
      // A commit healed from history records no also_by (M92.12).
      changesets: [
        committed('run-old', FIRST, [
          { ...file('healed.md', 'modified', 2, 2), also_by: null } as unknown as ChangedFile,
        ]),
      ],
    };
    render(<Panel messages={[asked('u-1'), replied('a-1')]} heal={heal} />);
    expect(within(row('healed.md')).queryByRole('button', { name: /^Jump to / })).toBeNull();
    expect(
      within(row('healed.md')).getByRole('button', { name: 'Open healed.md (leaves full screen)' }),
    ).toBeTruthy();
    expect(row('healed.md').textContent).toContain('who else edited it: not recorded');
  });
});

describe('a row’s second action', () => {
  it('floats the conversation first, then opens the page', () => {
    let during: string | null = null;
    onOpenPath.mockImplementation(() => {
      during = presentation();
    });
    render(<Panel messages={TIDY} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open old.md (leaves full screen)' }));
    expect(onOpenPath).toHaveBeenCalledWith('notes/old.md');
    expect(during).toBe('floating');
    expect(jump).not.toHaveBeenCalled();
  });

  it('opens a deleted file’s diff at the commit that deleted it, floating first', () => {
    let during: string | null = null;
    onViewDiff.mockImplementation(() => {
      during = presentation();
    });
    render(<Panel messages={TIDY} />);
    expect(
      within(row('notes/gone.md')).queryByRole('button', { name: /^Open gone\.md/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Open the diff of gone.md (leaves full screen)' }),
    );
    expect(onViewDiff).toHaveBeenCalledWith('notes/gone.md', SECOND);
    expect(during).toBe('floating');
  });

  it('offers a deleted file nothing where diffs cannot be shown', () => {
    render(<Panel messages={TIDY} onViewDiff={undefined} />);
    expect(within(row('notes/gone.md')).queryByTestId('rail-change-open')).toBeNull();
    expect(within(row('notes/old.md')).getByTestId('rail-change-open')).toBeTruthy();
  });
});

describe('pull requests', () => {
  const merged: PrRead = {
    state: 'read',
    checkedAt: '2026-10-14T12:00:00Z',
    pr: {
      number: 42,
      url: PR_URL,
      title: 'Tidy notes',
      state: 'MERGED',
      isDraft: false,
      mergedAt: '2026-10-14T11:00:00Z',
      closedAt: '2026-10-14T11:00:00Z',
      headRefName: 'tidy',
      baseRefName: 'main',
      author: 'me',
      body: null,
      reviewDecision: 'APPROVED',
      mergeStateStatus: null,
      updatedAt: null,
      checks: [],
    },
  };

  it('read their state only while the rail can be seen, read-only', async () => {
    seedPullRequests({ [PR_URL]: merged });
    const read = vi.spyOn(gitIpc, 'pullRequestState');
    const view = render(<Panel messages={[]} prLinks={[PR]} folded />);
    expect(card().dataset.state).toBe('ready');
    expect(within(card()).getByRole('button', { name: /^Jump to acme\/notes#42/ })).toBeTruthy();
    expect(screen.queryByTestId('rail-change-pr-state')).toBeNull();
    expect(read).not.toHaveBeenCalled();
    view.rerender(<Panel messages={[]} prLinks={[PR]} folded={false} />);
    await waitFor(() =>
      expect(screen.getByTestId('rail-change-pr-state').textContent).toBe('merged'),
    );
    expect(screen.getByTestId('rail-change-pr-state').dataset.state).toBe('merged');
    expect(read).toHaveBeenCalledWith(PR_URL, false);
  });

  it('say why where gh could not read one', async () => {
    seedPullRequests({});
    render(<Panel messages={[]} prLinks={[PR]} />);
    await waitFor(() =>
      expect(screen.getByTestId('rail-change-pr-state').textContent).toBe(
        "state unavailable: gh isn't installed",
      ),
    );
    expect(screen.getByTestId('rail-change-pr-state').dataset.state).toBe('unavailable');
  });

  it('show their link in the transcript, staying in the canvas', async () => {
    render(<Panel messages={TIDY} prLinks={[PR]} />);
    await act(async () => {});
    fireEvent.click(within(card()).getByRole('button', { name: /^Jump to acme\/notes#42/ }));
    const link = screen.getByTestId('thread-pr-links').querySelector(`a[href="${PR_URL}"]`);
    expect(link).not.toBeNull();
    expect(document.activeElement).toBe(link);
    expect(presentation()).toBe('canvas');
  });
});
