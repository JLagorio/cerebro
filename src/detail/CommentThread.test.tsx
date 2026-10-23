// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentThread as Thread, PageComment } from '@/engine/comments';
import { useVaultStore } from '@/stores/vaultStore';
import { CommentThread } from './CommentThread';
import type { PageCommentsController } from './usePageComments';

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/app/useOpenPath', () => ({ useOpenPath: () => open }));

/**
 * A thread's comments as Messages (M91.14): the person's and an agent's turn
 * in one thread, an agent's pending answer as working words under the
 * element's light, and its answer as the chat's markdown once it lands. The
 * thread only draws and hands a reply to its controller: it starts no turn
 * of its own (CV-36) and writes no page (CV-31).
 */

const NOW = new Date('2026-10-14T12:00:00Z');
const comment = (id: string, over: Partial<PageComment> = {}): PageComment => ({
  id,
  author: 'human:owner',
  created: '2026-10-14T11:00:00Z',
  body: `body ${id}`,
  ...over,
});

function controller(over: Partial<PageCommentsController> = {}): PageCommentsController {
  return {
    path: 'notes/page.md',
    slot: null,
    sections: null,
    focused: null,
    draft: null,
    start: vi.fn(),
    cancelDraft: vi.fn(),
    submitDraft: vi.fn(async () => null),
    startDiscussion: vi.fn(async () => null),
    reply: vi.fn(async () => 'reply-id'),
    setResolved: vi.fn(async () => true),
    deleteComment: vi.fn(async () => true),
    deleteThread: vi.fn(async () => true),
    focus: vi.fn(),
    ...over,
  };
}

function show(thread: Thread, control = controller()) {
  const id = thread.comments[0].id;
  const view = render(<CommentThread item={{ id, thread }} controller={control} now={NOW} />);
  return {
    control,
    rerender: (next: Thread) =>
      view.rerender(<CommentThread item={{ id, thread: next }} controller={control} now={NOW} />),
  };
}

const rows = () => screen.getAllByTestId('comment');

beforeEach(() => {
  open.mockReset();
  useVaultStore.setState({ entries: [] });
});
afterEach(cleanup);

describe('a comment row', () => {
  const asked = comment('00000000000000a1', { body: '@release-scout check this' });
  const pending = comment('00000000000000a2', {
    author: 'process:release-scout',
    body: '',
    state: 'pending',
    answers: '00000000000000a1',
  });

  it('is a Message: the person’s and the agent’s, both at the start', () => {
    show({ comments: [asked, pending] });
    const [person, agent] = rows();
    for (const row of [person, agent]) {
      expect(row.dataset.slot).toBe('message');
      expect(row.dataset.align).toBe('start');
      expect(row.querySelector('[data-slot="message-content"]')).not.toBeNull();
      expect(row.querySelector('[data-slot="message-header"]')).not.toBeNull();
    }
    expect(person.dataset.role).toBe('user');
    expect(agent.dataset.role).toBe('assistant');
    expect(person.dataset.commentId).toBe('00000000000000a1');
    // The agent's line carries the AI glyph; the person's does not.
    expect(agent.querySelector('[data-slot="message-header"] svg')).not.toBeNull();
    expect(person.querySelector('[data-slot="message-header"] svg')).toBeNull();
  });

  it('shows a pending answer as working words under the element’s light, with no body', () => {
    show({ comments: [asked, pending] });
    const row = rows()[1];
    expect(row.dataset.state).toBe('pending');
    const words = within(row).getByTestId('comment-pending');
    expect(words.textContent).toBe('@release-scout is answering…');
    expect(words.classList.contains('cb-ai-shimmer')).toBe(true);
    expect(row.querySelector('.cb-message-markdown')).toBeNull();
  });

  it('lands the answer as markdown in the placeholder’s place, rising in, with no light', () => {
    const view = show({ comments: [asked, pending] });
    view.rerender({
      comments: [asked, { ...pending, state: 'answered', body: 'Done **waiting**.' }],
    });
    const row = rows()[1];
    expect(row.dataset.state).toBe('answered');
    expect(within(row).queryByTestId('comment-pending')).toBeNull();
    expect(row.querySelector('.cb-ai-shimmer')).toBeNull();
    const body = row.querySelector('.cb-message-markdown');
    expect(body?.querySelector('strong')?.textContent).toBe('waiting');
    expect(body?.parentElement?.hasAttribute('data-arrive')).toBe(true);
  });

  it('says a failed turn in the quieter ink', () => {
    show({
      comments: [
        asked,
        { ...pending, state: 'failed', body: 'The agent could not answer: it is paused.' },
      ],
    });
    const body = rows()[1].querySelector('.cb-message-markdown')?.parentElement;
    expect(body?.className).toContain('text-n-400');
    expect(rows()[0].querySelector('.cb-message-markdown')?.parentElement?.className).toContain(
      'text-n-800',
    );
  });

  it('opens a wikilink in an answer through the app, never an href', () => {
    useVaultStore.setState({
      entries: [
        {
          path: 'inbox/welcome.md',
          filename: 'welcome.md',
          folder: 'inbox',
          project: null,
          title: 'Welcome',
          type: null,
          properties: {},
          relationships: {},
          outgoingLinks: [],
          snippet: '',
          createdAt: '2026-07-24T00:00:00.000Z',
          modifiedAt: '2026-07-24T00:00:00.000Z',
          parseError: null,
          hash: null,
        },
      ],
    });
    show({
      comments: [asked, { ...pending, state: 'answered', body: 'See [[welcome]].' }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Welcome' }));
    expect(open).toHaveBeenCalledWith('inbox/welcome.md');
    for (const link of document.querySelectorAll('a')) {
      expect(link.getAttribute('href') ?? '').toMatch(/^https?:\/\//);
    }
  });

  it('keeps delete behind its confirm, and a deleted comment is a tombstone', async () => {
    const { control, rerender } = show({ comments: [asked, pending] });
    const row = rows()[1];
    fireEvent.click(within(row).getByTestId('comment-delete'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('comment-delete-confirm'));
    });
    expect(control.deleteComment).toHaveBeenCalledWith('00000000000000a1', '00000000000000a2');
    rerender({ comments: [asked, { ...pending, deleted: { at: NOW.toISOString(), by: 'x' } }] });
    expect(screen.getByTestId('comment-tombstone').textContent).toBe('Comment deleted.');
  });
});

describe('a reply', () => {
  it('hands the person’s text to the controller and nothing else asks an agent', async () => {
    const control = controller({ focused: '00000000000000b1' });
    show(
      {
        comments: [
          comment('00000000000000b1'),
          // An agent's own comment naming another agent asks nobody.
          comment('00000000000000b2', {
            author: 'process:release-scout',
            body: '@other-agent can you look?',
          }),
        ],
      },
      control,
    );
    const input = screen.getByTestId('comment-reply-submit-input');
    fireEvent.change(input, { target: { value: 'Thanks, that settles it.' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('comment-reply-submit'));
    });
    expect(control.reply).toHaveBeenCalledExactlyOnceWith(
      '00000000000000b1',
      'Thanks, that settles it.',
    );
    for (const call of [
      control.startDiscussion,
      control.submitDraft,
      control.start,
      control.deleteComment,
    ]) {
      expect(call).not.toHaveBeenCalled();
    }
  });
});
