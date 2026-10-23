// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLayers } from '@/components/ui/layers';
import { CommentComposer } from './CommentComposer';

/**
 * Where a comment is written (M70.2b), on the Prompt Input's anatomy
 * (M91.14). Its ids, its name and its keys are what the comment specs and
 * the panel drive it by: the field is `${testId}-input`, named by its
 * placeholder; the button is `testId`, named by what it does; ⌘Enter posts
 * and a bare Enter is a new line of the comment.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => resetLayers());

function compose(over: Partial<Parameters<typeof CommentComposer>[0]> = {}) {
  const onSubmit = vi.fn(async (_body: string): Promise<unknown> => 'posted');
  const props = {
    placeholder: 'Start a discussion…',
    submitLabel: 'Post',
    testId: 'discussion-submit',
    onSubmit,
    ...over,
  };
  render(<CommentComposer {...props} />);
  const field = screen.getByTestId('discussion-submit-input') as HTMLTextAreaElement;
  return { field, onSubmit: props.onSubmit, submit: () => screen.getByTestId('discussion-submit') };
}

const type = (field: HTMLTextAreaElement, value: string) =>
  fireEvent.change(field, { target: { value } });

describe('CommentComposer', () => {
  it('keeps its ids and names inside one Prompt Input box', () => {
    const { field, submit } = compose();
    const box = field.closest('.cb-composer');
    expect(box?.getAttribute('data-slot')).toBe('prompt-input');
    expect(field.dataset.slot).toBe('prompt-input-textarea');
    expect(field.getAttribute('aria-label')).toBe('Start a discussion…');
    expect(field.getAttribute('placeholder')).toBe('Start a discussion…');
    expect(field.tagName).toBe('TEXTAREA');
    expect(submit().dataset.slot).toBe('prompt-input-submit');
    expect(screen.getByRole('button', { name: 'Post' })).toBe(submit());
    expect(submit().textContent).toBe('Post');
    expect(box?.contains(submit())).toBe(true);
    // Nothing written, nothing to post.
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
  });

  it('posts on ⌘ or Ctrl+Enter, and leaves a bare Enter to the comment’s new line', async () => {
    const { field, onSubmit } = compose();
    type(field, 'First line');
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('First line');
    expect(field.value).toBe('');
    type(field, 'Second');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    });
    expect(onSubmit).toHaveBeenLastCalledWith('Second');
  });

  it('never posts the Enter that ends an IME composition', () => {
    const { field, onSubmit } = compose();
    type(field, '変換');
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true, isComposing: true });
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('waits while a post is in flight, and keeps the text a refusal sent back', async () => {
    let settle: (landed: unknown) => void = () => undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          settle = resolve;
        }),
    );
    const { field, submit } = compose({ onSubmit });
    type(field, 'Is 72 enough?');
    fireEvent.click(submit());
    expect(field.disabled).toBe(true);
    expect(field.closest('.cb-composer')?.hasAttribute('data-busy')).toBe(true);
    expect((submit() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => settle(null));
    expect(field.disabled).toBe(false);
    expect(field.value).toBe('Is 72 enough?');
    fireEvent.click(submit());
    await act(async () => settle('landed'));
    expect(field.value).toBe('');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('cancels on Escape only while it has focus', () => {
    const onCancel = vi.fn();
    const { field } = compose({ onCancel });
    type(field, 'Never mind');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.focus(field);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(field.value).toBe('');
  });

  it('puts the caret in the field from a press anywhere else in its box', () => {
    const { field } = compose();
    const bar = field.closest('.cb-composer')?.querySelector('.cb-composer-bar');
    fireEvent.click(bar!);
    expect(document.activeElement).toBe(field);
  });

  it('keeps its draft through the store it is handed', () => {
    const drafts = new Map<string, string>([['reply', 'Half a thought']]);
    const { field } = compose({
      draft: { read: () => drafts.get('reply') ?? '', write: (v) => drafts.set('reply', v) },
    });
    expect(field.value).toBe('Half a thought');
    type(field, 'Half a thought, finished');
    expect(drafts.get('reply')).toBe('Half a thought, finished');
  });

  it('adds no document keydown listener: its keys are its own field’s', async () => {
    const listen = vi.spyOn(document, 'addEventListener');
    const { field, onSubmit } = compose({ onCancel: () => undefined });
    fireEvent.focus(field);
    type(field, 'Hello');
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    });
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(listen.mock.calls.filter(([kind]) => kind === 'keydown')).toEqual([]);
  });
});
