// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TextSelection } from 'prosemirror-state';
import { MarkdownEditor, type CerebroEditor, type EditorReadyInfo } from './MarkdownEditor';
import { NotePathContext } from './notePath';
import { useVaultStore } from '@/stores/vaultStore';

const handlers: Array<(event: unknown) => void> = [];
vi.mock('@/agent/agentIpc', () => ({
  runAgent: vi.fn(async () => ({ run: 1, durableId: null })),
  startedOrThrow: (start: { run: number }) => start,
  onAgentEvent: vi.fn((handler: (event: unknown) => void) => {
    handlers.push(handler);
    return () => {
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index, 1);
    };
  }),
}));

const ORIGINAL = 'Some words here.\n\nAnother paragraph.\n';
const REPLACED = 'Better words here.\n\nAnother paragraph.\n';

const select = (editor: CerebroEditor, from = 3, to = 7) =>
  act(() => {
    editor.focus();
    editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, from, to)));
  });

async function openRewrite(replyText = 'Better', selectionEnd = 7) {
  const ready = vi.fn<(info: EditorReadyInfo) => void>();
  const save = vi.fn();
  const dirty = vi.fn();
  const props = {
    markdown: ORIGINAL,
    onChange: save,
    onDirty: dirty,
    onReady: ready,
    debounceMs: 60000,
  };
  const page = (path: string, readOnly = false) => (
    <NotePathContext.Provider value={path}>
      <MarkdownEditor {...props} readOnly={readOnly} />
    </NotePathContext.Provider>
  );
  const rendered = render(page('page.md'));
  await waitFor(() => expect(ready).toHaveBeenCalled());
  const info = ready.mock.calls[0][0];
  await waitFor(() => expect(info.editor.domElement?.textContent).toContain('Some words here.'));
  select(info.editor, 3, selectionEnd);
  fireEvent.click(await screen.findByRole('button', { name: 'Ask AI' }));
  const input = await screen.findByLabelText('What should the assistant do with this passage?');
  fireEvent.change(input, { target: { value: 'Improve' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(handlers).toHaveLength(1));
  act(() => {
    for (const handler of [...handlers]) handler({ run: 1, kind: 'Result', text: replyText });
    for (const handler of [...handlers]) handler({ run: 1, kind: 'Done' });
  });
  await screen.findByTestId('ask-ai-decision');
  return {
    info,
    save,
    dirty,
    rerender: (path: string, readOnly = false) => rendered.rerender(page(path, readOnly)),
  };
}

const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
const conflict = () =>
  expect(screen.getByRole('alert').textContent).toMatch(/reselect|select.*again/i);

beforeEach(() => {
  handlers.length = 0;
  useVaultStore.setState({ vaultPath: '/vault', entries: [] });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('selected passage Apply in the actual editor', () => {
  it('replaces the captured range despite focus collapse, saves once and isolates its Undo', async () => {
    const { info, save, dirty } = await openRewrite();
    act(() => info.editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, 7))));
    const button = screen.getByRole('button', { name: 'Apply' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(info.serialize()).toBe(REPLACED);
    expect(dirty).toHaveBeenCalledOnce();
    await act(async () => {
      await info.flushPendingSave();
    });
    expect(save.mock.calls).toEqual([[REPLACED]]);
    act(() => {
      info.editor.transact((tr) => tr.insertText('!', 9));
    });
    act(() => void info.editor.undo());
    expect(info.serialize()).toBe(REPLACED);
    act(() => void info.editor.undo());
    expect(info.serialize()).toBe(ORIGINAL);
  });

  it.each([
    'shifted identical passage',
    'unrelated edit',
    'edit then undo',
    'external replacement',
  ])('retains its proposal and writes nothing after %s', async (change) => {
    const { info, save, dirty } = await openRewrite();
    act(() => {
      if (change === 'shifted identical passage')
        info.editor.transact((tr) => tr.insertText('X', 3));
      if (change === 'unrelated edit')
        info.editor.insertBlocks(
          [{ type: 'paragraph', content: 'new' }],
          info.editor.document[1],
          'after',
        );
      if (change === 'edit then undo') {
        info.editor.transact((tr) => tr.insertText('X', 3));
        info.editor.undo();
      }
      if (change === 'external replacement')
        info.applyExternal(ORIGINAL.replace('Another', 'Updated'), info.loadedAs);
    });
    const before = info.serialize();
    dirty.mockClear();
    apply();
    expect(info.serialize()).toBe(before);
    expect(save).not.toHaveBeenCalled();
    expect(dirty).not.toHaveBeenCalled();
    conflict();
    expect(screen.getByTestId('ask-ai-hunks').textContent).toContain('Better');
  });

  it.each(['page rename', 'vault round trip', 'read-only'])(
    'refuses Apply after %s without losing the proposal',
    async (change) => {
      const { info, dirty, rerender } = await openRewrite();
      if (change === 'page rename') rerender('renamed.md');
      if (change === 'read-only') rerender('page.md', true);
      if (change === 'vault round trip')
        act(() => {
          useVaultStore.setState({ vaultPath: '/other' });
          useVaultStore.setState({ vaultPath: '/vault' });
        });
      apply();
      expect(info.serialize()).toBe(ORIGINAL);
      expect(dirty).not.toHaveBeenCalled();
      conflict();
      expect(screen.getByTestId('ask-ai-hunks').textContent).toContain('Better');
    },
  );

  it.each(['Some   words', 'Better   words'])(
    'Keep mine retains exact text and schedules no save for %s',
    async (replyText) => {
      const { info, dirty, save } = await openRewrite(replyText, 13);
      for (const hunk of screen.queryAllByTestId('ask-ai-hunk')) fireEvent.click(hunk);
      fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
      await act(async () => {
        await info.flushPendingSave();
      });
      expect(info.serialize()).toBe(ORIGINAL);
      expect(dirty).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
    },
  );

  it('Cancel leaves the original unchanged and schedules no save', async () => {
    const { info, dirty, save } = await openRewrite();
    fireEvent.keyDown(screen.getByTestId('ask-ai'), { key: 'Escape' });
    await act(async () => {
      await info.flushPendingSave();
    });
    expect(info.serialize()).toBe(ORIGINAL);
    expect(dirty).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
});
