// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { __resetOpenPages, registerSaveParticipant } from '@/editor/openPages';
import { DocumentOwner } from '@/editor/documentOwner';
import * as ipc from '@/lib/ipc';
import * as mock from '@/lib/mockIpc';
import { useVaultStore } from '@/stores/vaultStore';
import { useUndoStore } from '@/stores/undoStore';
import { useUiStore } from '@/stores/uiStore';
import { Message } from './ChatTurn';
import type { ChatMessage } from './types';

vi.mock('@/lib/ipc', { spy: true });
const VAULT = '/demo-vault';
const TEXT =
  '  **An exact answer**\n\n---\nstatus: just prose\n---\n\n<script>noExecution()</script>\n';
const fs = () => (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
const handlers = { onOpen: vi.fn(), onOpenPath: vi.fn() };
const answer = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'answer',
  role: 'assistant',
  text: TEXT,
  tools: [],
  ...over,
});
function preview() {
  fireEvent.click(screen.getByRole('button', { name: 'Save answer' }));
  return screen.getByRole('dialog', { name: 'Save answer as page' });
}
function namePage(dialog: HTMLElement, title = 'Saved answer') {
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Page title' }), {
    target: { value: title },
  });
}

beforeEach(async () => {
  __resetOpenPages();
  vi.resetAllMocks();
  mock.resetMockFs();
  fs().set('notes/artifact-control.md', '# Control\n');
  await useVaultStore.getState().openVault(VAULT);
  useUndoStore.getState().clear();
  useUiStore.setState({ toasts: [] });
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  __resetOpenPages();
  vi.resetAllMocks();
});

it('previews only the selected final answer and Cancel writes nothing', () => {
  const message = answer({
    text: 'obsolete aggregate',
    parts: [
      { kind: 'text', id: 'intro', text: 'Narration is not the answer.' },
      { kind: 'reasoning', id: 'thinking', text: 'Private reasoning.' },
      { kind: 'text', id: 'answer', text: TEXT },
    ],
  });
  const before = structuredClone(message);
  render(<Message message={message} {...handlers} />);
  const dialog = preview();
  expect(within(dialog).getByTestId('answer-save-preview').textContent).toBe(TEXT);
  expect(dialog.querySelector('script')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(ipc.applyBatch).not.toHaveBeenCalled();
  expect(message).toEqual(before);
});

it('uses only the existing dialog Escape/Tab handlers and removes both on close', () => {
  const add = vi.spyOn(document, 'addEventListener');
  const remove = vi.spyOn(document, 'removeEventListener');
  render(<Message message={answer()} {...handlers} />);
  expect(add.mock.calls.filter(([type]) => type === 'keydown')).toEqual([]);
  const dialog = preview();
  const keys = add.mock.calls.filter(([type]) => type === 'keydown');
  expect(keys).toHaveLength(2);
  expect(keys.map(([, callback, capture]) => [(callback as EventListener).name, capture])).toEqual([
    ['onEscape', undefined],
    ['onTab', true],
  ]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  for (const [type, callback, capture] of keys)
    expect(
      remove.mock.calls.some(
        ([removedType, removed, captured]) =>
          removedType === type && removed === callback && captured === capture,
      ),
    ).toBe(true);
  add.mockRestore();
  remove.mockRestore();
});

it('creates the reviewed destination through one batch with one working Undo', async () => {
  render(<Message message={answer()} {...handlers} />);
  const dialog = preview();
  namePage(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Folder' }));
  fireEvent.click(screen.getByRole('option', { name: 'notes' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save page' }));
  await waitFor(() => expect(fs().get('notes/saved-answer.md')).toBe(`# Saved answer\n\n${TEXT}`));
  expect(ipc.applyBatch).toHaveBeenCalledExactlyOnceWith(VAULT, [
    { op: 'create', path: 'notes/saved-answer.md', content: `# Saved answer\n\n${TEXT}` },
  ]);
  expect(useUndoStore.getState().past).toHaveLength(1);
  await act(async () => {
    expect(await useUndoStore.getState().undo()).toBe(true);
  });
  expect(fs().has('notes/saved-answer.md')).toBe(false);
});

it('keeps the preview and title on collision, then saves only after a new destination is chosen', async () => {
  fs().set('saved-answer.md', '# Existing\nKeep this.');
  render(<Message message={answer()} {...handlers} />);
  const dialog = preview();
  namePage(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save page' }));
  await within(dialog).findByRole('alert');
  expect(fs().get('saved-answer.md')).toBe('# Existing\nKeep this.');
  expect(
    (within(dialog).getByRole('textbox', { name: 'Page title' }) as HTMLInputElement).value,
  ).toBe('Saved answer');
  expect(within(dialog).getByTestId('answer-save-preview').textContent).toBe(TEXT);
  namePage(dialog, 'Second destination');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save page' }));
  await waitFor(() =>
    expect(fs().get('second-destination.md')).toBe(`# Second destination\n\n${TEXT}`),
  );
  expect(useUndoStore.getState().past).toHaveLength(1);
});

it('does not overwrite a file created outside the app while the save starts', async () => {
  vi.mocked(ipc.applyBatch).mockImplementationOnce(async (vault, ops) => {
    fs().set('saved-answer.md', 'External bytes');
    return mock.applyBatch(vault, ops);
  });
  render(<Message message={answer()} {...handlers} />);
  const dialog = preview();
  namePage(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save page' }));
  await within(dialog).findByRole('alert');
  expect(fs().get('saved-answer.md')).toBe('External bytes');
  expect(useUndoStore.getState().past).toHaveLength(0);
});

it('preserves a frozen preview and saved page when the answer is regenerated', async () => {
  const { rerender } = render(<Message message={answer()} {...handlers} />);
  const dialog = preview();
  namePage(dialog);
  rerender(<Message message={answer({ text: 'A different regenerated answer.' })} {...handlers} />);
  expect(within(dialog).getByTestId('answer-save-preview').textContent).toBe(TEXT);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save page' }));
  await waitFor(() => expect(fs().get('saved-answer.md')).toBe(`# Saved answer\n\n${TEXT}`));
  rerender(<Message message={answer({ text: 'Yet another answer.' })} {...handlers} />);
  expect(fs().get('saved-answer.md')).toBe(`# Saved answer\n\n${TEXT}`);
  expect(ipc.applyBatch).toHaveBeenCalledOnce();
});

it.each(['streaming', 'gap', 'rekeyed'] as const)(
  'retains the open preview and title while the answer is %s',
  (phase) => {
    const { rerender } = render(<Message message={answer()} {...handlers} />);
    const dialog = preview();
    namePage(dialog, 'Keep this title');
    rerender(
      <Message
        message={answer(
          phase === 'rekeyed'
            ? { parts: [{ kind: 'text', id: 'replacement-final', text: 'A rekeyed answer.' }] }
            : { text: '', [phase]: true },
        )}
        {...handlers}
      />,
    );
    expect(screen.getByRole('dialog', { name: 'Save answer as page' })).toBe(dialog);
    expect(within(dialog).getByTestId('answer-save-preview').textContent).toBe(TEXT);
    expect(
      (within(dialog).getByRole('textbox', { name: 'Page title' }) as HTMLInputElement).value,
    ).toBe('Keep this title');
    rerender(<Message message={answer({ text: 'A new completed answer.' })} {...handlers} />);
    expect(within(dialog).getByTestId('answer-save-preview').textContent).toBe(TEXT);
    expect(ipc.applyBatch).not.toHaveBeenCalled();
  },
);

it('retires the original preview across an A to B to A vault transition', async () => {
  render(<Message message={answer()} {...handlers} />);
  const dialog = preview();
  namePage(dialog);
  act(() => {
    useVaultStore.setState({ vaultPath: '/other' });
    useVaultStore.setState({ vaultPath: VAULT });
  });
  expect(within(dialog).getByRole('button', { name: 'Save page' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(within(dialog).getByTestId('answer-save-preview').textContent).toBe(TEXT);
  expect(ipc.applyBatch).not.toHaveBeenCalled();
});

it('refuses before the create when a pending editor cannot save, retaining its draft', async () => {
  const path = 'notes/dirty-artifact-control.md';
  fs().set(path, '# Before\n');
  const owner = new DocumentOwner(
    { vaultId: VAULT, path, ownerId: 'artifact-control' },
    '# Before\n',
    (body) => ipc.saveNoteBody({ vault: VAULT, path, body }),
  );
  registerSaveParticipant({
    key: owner.key,
    prepare: () => {},
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  owner.edit('# Keep my draft\n');
  vi.mocked(ipc.saveNoteBody).mockRejectedValueOnce(Error('disk full'));
  render(<Message message={answer()} {...handlers} />);
  const dialog = preview();
  namePage(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save page' }));
  await within(dialog).findByRole('alert');
  expect(ipc.applyBatch).not.toHaveBeenCalled();
  expect(owner.snapshot().latestDraft).toBe('# Keep my draft\n');
  expect(fs().has('saved-answer.md')).toBe(false);
});

it('admits only one create while its acknowledgement is pending', async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(ipc.applyBatch).mockImplementationOnce(async (vault, ops) => {
    await wait;
    return mock.applyBatch(vault, ops);
  });
  render(<Message message={answer()} {...handlers} />);
  const dialog = preview();
  namePage(dialog);
  const save = within(dialog).getByRole('button', { name: 'Save page' });
  fireEvent.click(save);
  fireEvent.click(save);
  await waitFor(() => expect(ipc.applyBatch).toHaveBeenCalledOnce());
  expect(within(dialog).getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.getByRole('dialog')).toBe(dialog);
  await act(async () => {
    release();
  });
  await within(dialog).findByRole('button', { name: 'Open page' });
  expect(ipc.applyBatch).toHaveBeenCalledOnce();
  expect(useUndoStore.getState().past).toHaveLength(1);
});

it('refuses the create if saving an open editor retires the original vault', async () => {
  const path = 'notes/artifact-control.md';
  const owner = new DocumentOwner(
    { vaultId: VAULT, path, ownerId: 'artifact-control' },
    '# Control\n',
    async (body) => {
      const result = await mock.saveNoteBody({ vault: VAULT, path, body });
      useVaultStore.setState({ vaultPath: '/other' });
      useVaultStore.setState({ vaultPath: VAULT });
      return result;
    },
  );
  registerSaveParticipant({
    key: owner.key,
    prepare: () => {},
    snapshot: () => owner.snapshot(),
    flush: () => owner.flush(),
  });
  owner.edit('# My control edit\n');
  render(<Message message={answer()} {...handlers} />);
  const dialog = preview();
  namePage(dialog);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save page' }));
  await within(dialog).findByRole('alert');
  expect(ipc.applyBatch).not.toHaveBeenCalled();
  expect(fs().has('saved-answer.md')).toBe(false);
});
