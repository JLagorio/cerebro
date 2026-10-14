// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createStore } from '@blocknote/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectionAnchor } from '@/editor/commentHighlights';
import type { CerebroEditor } from '@/editor/MarkdownEditor';
import type { AnchorResolution, CommentAnchor } from '@/engine/commentAnchor';
import {
  parseComments,
  serializeComments,
  sidecarPathOf,
  type CommentsFile,
  type PageComment,
} from '@/engine/comments';
import { resetMockFs } from '@/lib/mockIpc';
import { useCommentsStore } from '@/stores/commentsStore';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { CommentsTab } from './CommentsTab';
import { usePageComments } from './usePageComments';

/**
 * The Comments tab (M70.2b), driven by the real hook over the mock backend,
 * with a fake CommentHighlights standing in for the editor: what a click
 * writes is read back from the mock disk.
 */

const PAGE = 'records/decisions/dec-offline-window-72h.md';
const NOW = new Date('2026-10-14T12:00:00Z');
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const sidecar = (): CommentsFile => {
  const parsed = parseComments(fs().get(sidecarPathOf(PAGE)) ?? '');
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.file;
};
const seed = (file: CommentsFile) => fs().set(sidecarPathOf(PAGE), serializeComments(file));

const anchor = (quote: string): CommentAnchor => ({ quote, occurrence: 1, before: '', after: '' });
const comment = (id: string, over: Partial<PageComment> = {}): PageComment => ({
  id,
  author: 'human:owner',
  created: '2026-10-14T11:00:00Z',
  body: `body ${id}`,
  ...over,
});
const stamp = { at: '2026-10-14T11:30:00Z', by: 'human:owner' };

function fakeHighlights() {
  let selection: SelectionAnchor = { ok: false, reason: 'empty' };
  return {
    store: createStore({ resolutions: new Map<string, AnchorResolution>() }),
    setThreads: vi.fn(),
    setActive: vi.fn(),
    setPending: vi.fn(),
    reveal: vi.fn(() => true),
    anchorSelection: () => selection,
    onSelect: () => () => true,
    select(quote: string) {
      selection = { ok: true, anchor: anchor(quote), start: 0, end: quote.length };
    },
  };
}

let fake: ReturnType<typeof fakeHighlights>;
let editor: CerebroEditor;

function Harness() {
  const controller = usePageComments(PAGE, editor, {
    openPanel: () => undefined,
    deepLink: null,
  });
  return (
    <>
      <button type="button" data-testid="start" onClick={() => controller.start()} />
      <CommentsTab controller={controller} now={NOW} />
    </>
  );
}

async function show() {
  render(<Harness />);
  await waitFor(() => expect(screen.queryByTestId('comments-tab')).not.toBeNull());
}

const threads = () => screen.queryAllByTestId('comment-thread');
const threadNamed = (id: string) =>
  screen.getAllByTestId('comment-thread').find((t) => t.dataset.threadId === id)!;

beforeEach(async () => {
  resetMockFs();
  await useVaultStore.getState().openVault('/demo-vault');
  useCommentsStore.getState().clear();
  useUiStore.setState({ toasts: [], detailPath: null });
  useNavStore.setState({
    selection: { kind: 'home' },
    history: [{ kind: 'home' }],
    historyIndex: 0,
  });
  fake = fakeHighlights();
  editor = { getExtension: () => fake } as unknown as CerebroEditor;
});
afterEach(cleanup);

describe('CommentsTab', () => {
  it('says why an unreadable sidecar is unavailable, with no empty state and no composer', async () => {
    fs().set(sidecarPathOf(PAGE), '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n');
    render(<Harness />);
    const unavailable = await screen.findByTestId('section-unavailable');
    expect(unavailable.textContent).toMatch(/merge conflict markers/);
    expect(screen.queryByText('No comments yet')).toBeNull();
    expect(screen.queryByTestId('discussion-submit')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows the empty state above the composer when there is nothing', async () => {
    await show();
    expect(screen.getByText('No comments yet')).toBeTruthy();
    expect(
      screen.getByText('Select text and press Comment, or start a discussion below.'),
    ).toBeTruthy();
    expect(screen.getByTestId('discussion-submit-input')).toBeTruthy();
  });

  it('draws each section, with the notes, and folds Resolved', async () => {
    seed({
      format: 1,
      threads: [
        { anchor: anchor('Guarantee 72 hours.'), comments: [comment('00000000000000b1')] },
        { anchor: anchor('warns'), comments: [comment('00000000000000b2')] },
        { anchor: anchor('human'), comments: [comment('00000000000000b3')] },
        { comments: [comment('00000000000000b4')] },
        { resolved: stamp, comments: [comment('00000000000000b5')] },
      ],
    });
    await show();
    act(() =>
      fake.store.setState(() => ({
        resolutions: new Map<string, AnchorResolution>([
          ['00000000000000b1', { kind: 'attached', start: 0, end: 19, moved: false }],
          ['00000000000000b2', { kind: 'detached', reason: 'ambiguous', count: 2 }],
        ]),
      })),
    );
    const onPage = screen.getByTestId('comments-on-page');
    expect(within(onPage).getByTestId('comment-quote').textContent).toBe('Guarantee 72 hours.');
    expect(screen.getByText("Open the page's text to see where each comment sits.")).toBeTruthy();
    const unplaced = screen.getByTestId('comments-unplaced');
    expect(within(unplaced).getByTestId('comment-thread').dataset.threadId).toBe(
      '00000000000000b3',
    );
    const discussion = screen.getByTestId('comments-discussion');
    expect(within(discussion).getByTestId('comment-note').textContent).toBe(
      "This text now appears 2 times on the page, so the comment can't tell which one it meant.",
    );
    expect(
      within(discussion)
        .getAllByTestId('comment-thread')
        .map((t) => t.dataset.threadId),
    ).toEqual(['00000000000000b2', '00000000000000b4']);
    const resolved = screen.getByTestId('comments-resolved') as HTMLDetailsElement;
    expect(resolved.open).toBe(false);
    expect(within(resolved).getByTestId('comment-resolved-by').textContent).toBe(
      'Resolved by You 30 minutes ago',
    );
    expect(screen.queryByText('No comments yet')).toBeNull();
    // A gone quote reads its own note.
    act(() =>
      fake.store.setState(() => ({
        resolutions: new Map<string, AnchorResolution>([
          ['00000000000000b1', { kind: 'detached', reason: 'gone', count: 0 }],
        ]),
      })),
    );
    expect(
      within(screen.getByTestId('comments-discussion')).getByText(
        'The text this comment was about is no longer on the page.',
      ),
    ).toBeTruthy();
  });

  it('posts a draft with ⌘Enter, and Escape drops one', async () => {
    const before = fs().get(PAGE);
    await show();
    fake.select('Guarantee 72 hours.');
    fireEvent.click(screen.getByTestId('start'));
    const draft = screen.getByTestId('comment-draft');
    expect(draft.textContent).toContain('Guarantee 72 hours.');
    const input = within(draft).getByTestId('comment-draft-submit-input');
    fireEvent.change(input, { target: { value: 'Is 72 enough for rural crews?' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    });
    await waitFor(() => expect(screen.queryByTestId('comment-draft')).toBeNull());
    expect(threads()).toHaveLength(1);
    expect(threads()[0].dataset.focused).toBe('true');
    expect(threads()[0].dataset.anchor).toBe('Guarantee 72 hours.');
    expect(sidecar().threads[0].comments[0].body).toBe('Is 72 enough for rural crews?');
    expect(fs().get(PAGE)).toBe(before);

    fake.select('warns');
    fireEvent.click(screen.getByTestId('start'));
    const again = screen.getByTestId('comment-draft-submit-input');
    fireEvent.focus(again);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('comment-draft')).toBeNull();
    expect(fake.setPending).toHaveBeenLastCalledWith(null);
  });

  it('replies, resolves and reopens', async () => {
    seed({ format: 1, threads: [{ comments: [comment('00000000000000c1')] }] });
    await show();
    const card = threadNamed('00000000000000c1');
    fireEvent.change(within(card).getByTestId('comment-reply-submit-input'), {
      target: { value: 'Agreed.' },
    });
    await act(async () => {
      fireEvent.click(within(card).getByTestId('comment-reply-submit'));
    });
    await waitFor(() => expect(screen.getByText('Agreed.')).toBeTruthy());
    expect(sidecar().threads[0].comments.map((c) => c.body)).toEqual([
      'body 00000000000000c1',
      'Agreed.',
    ]);

    await act(async () => {
      fireEvent.click(screen.getByTestId('comment-resolve'));
    });
    await waitFor(() =>
      expect(within(screen.getByTestId('comments-resolved')).getByTestId('comment-thread')),
    );
    expect(sidecar().threads[0].resolved?.by).toBe('human:owner');

    await act(async () => {
      fireEvent.click(screen.getByTestId('comment-reopen'));
    });
    await waitFor(() => expect(screen.queryByTestId('comments-resolved')).toBeNull());
    expect(sidecar().threads[0].resolved).toBeUndefined();
  });

  it('a deleted comment leaves a tombstone, and a deleted thread goes after its confirm', async () => {
    seed({
      format: 1,
      threads: [
        {
          comments: [
            comment('00000000000000d1'),
            comment('00000000000000d2', { body: 'The reply stays.' }),
          ],
        },
      ],
    });
    await show();
    const root = screen
      .getAllByTestId('comment')
      .find((c) => c.dataset.commentId === '00000000000000d1')!;
    fireEvent.click(within(root).getByTestId('comment-delete'));
    await act(async () => {
      fireEvent.click(within(root).getByTestId('comment-delete-confirm'));
    });
    await waitFor(() =>
      expect(screen.getByTestId('comment-tombstone').textContent).toBe('Comment deleted.'),
    );
    expect(screen.getByText('The reply stays.')).toBeTruthy();
    expect(sidecar().threads[0].comments[0]).toMatchObject({ body: '', deleted: {} });

    fireEvent.click(screen.getByTestId('comment-thread-delete'));
    expect(screen.getByText('Delete this thread and its 1 comment?')).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByTestId('comment-thread-delete-confirm'));
    });
    await waitFor(() => expect(threads()).toHaveLength(0));
    expect(sidecar().threads[0].deleted?.by).toBe('human:owner');
  });

  it('names authors as a reader would, and shows a pending answer', async () => {
    seed({
      format: 1,
      threads: [
        {
          comments: [
            comment('00000000000000e1', { body: '@release-scout check this' }),
            comment('00000000000000e2', {
              author: 'process:release-scout',
              body: '',
              state: 'pending',
            }),
            comment('00000000000000e3', { author: 'process:retired-bot', body: 'old' }),
            comment('00000000000000e4', { author: 'claude-code', body: 'From the panel.' }),
          ],
        },
      ],
    });
    await show();
    const rows = screen.getAllByTestId('comment');
    const who = rows.map((r) => r.querySelector('.font-medium')?.textContent);
    expect(who).toEqual(['You', 'Release scout', '@retired-bot', 'Assistant']);
    expect(rows[1].dataset.state).toBe('pending');
    expect(within(rows[1]).getByTestId('comment-pending').textContent).toBe(
      'Release scout is answering…',
    );
  });

  it('a wikilink in a body opens its page', async () => {
    const target = useVaultStore.getState().entries.find((e) => e.path === 'inbox/welcome.md');
    if (target === undefined) throw new Error('fixture vault has no inbox/welcome.md');
    seed({
      format: 1,
      threads: [{ comments: [comment('00000000000000f1', { body: 'See [[welcome]].' })] }],
    });
    await show();
    fireEvent.click(screen.getByRole('button', { name: target.title }));
    expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'inbox/welcome.md' });
  });
});
