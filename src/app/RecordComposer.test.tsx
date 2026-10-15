// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureVault, makeEntry } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
import type { ContentSearch } from './useContentSearch';
import { RecordComposer } from './RecordComposer';

let content: ContentSearch = { status: 'idle' };
vi.mock('./useContentSearch', () => ({ useContentSearch: () => content }));

beforeEach(() => {
  vi.restoreAllMocks();
  content = { status: 'idle' };
  const entries = fixtureVault();
  const work = entries.find((entry) => entry.type === 'Type' && entry.title === 'Work item')!;
  work.properties.layout = { heading: ['status', 'priority'] } as never;
  entries.push(
    ...['Collection', 'Agent', 'Skill'].map((title) =>
      makeEntry({ path: `types/${title}.md`, title, type: 'Type' }),
    ),
  );
  useVaultStore.setState({ entries, vaultPath: '/vault', entriesVault: '/vault' });
  useUiStore.setState({ toasts: [] });
});
afterEach(cleanup);

function setup(createItem = vi.fn().mockResolvedValue('records/work-items/new-task.md')) {
  useVaultStore.setState({ createItem });
  const onClose = vi.fn();
  const navigate = vi
    .spyOn(useNavStore.getState(), 'navigate')
    .mockImplementation(() => ({ kind: 'unchanged', pane: useNavStore.getState().active }));
  const { unmount } = render(<RecordComposer onClose={onClose} />);
  return { createItem, onClose, navigate, unmount };
}
const selectWork = () =>
  fireEvent.change(screen.getByTestId('composer-database'), { target: { value: 'Work item' } });
const title = (value: string) =>
  fireEvent.change(screen.getByTestId('composer-title'), { target: { value } });
function highPriority() {
  const cell = screen
    .getByTestId('heading-strip')
    .querySelector('[data-field="priority"]') as HTMLElement;
  fireEvent.click(within(cell).getByRole('button'));
  fireEvent.click(screen.getByRole('option', { name: 'High' }));
}

describe('RecordComposer', () => {
  it('keeps a suggested title editable', () => {
    render(<RecordComposer defaultTitle="Suggested page" onClose={vi.fn()} />);
    expect(screen.getByTestId('composer-title')).toHaveProperty('value', 'Suggested page');
    title('My own name');
    expect(screen.getByTestId('composer-title')).toHaveProperty('value', 'My own name');
  });

  it('excludes reserved databases and resets draft values when the database changes', () => {
    setup();
    expect(
      within(screen.getByTestId('composer-database'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Person', 'Project', 'Work item']);
    selectWork();
    highPriority();
    expect(screen.getByRole('button', { name: 'High' })).toBeTruthy();
    fireEvent.change(screen.getByTestId('composer-database'), { target: { value: 'Project' } });
    expect(screen.queryByTestId('heading-strip')).toBeNull();
    selectWork();
    expect(screen.queryByRole('button', { name: 'High' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Todo' })).toBeTruthy();
  });

  it.each([{ key: 'Enter' }, { key: 'Enter', metaKey: true }, { key: 'Enter', ctrlKey: true }])(
    'creates by $key with chosen fields, then opens the page',
    async (key) => {
      const { createItem, onClose, navigate } = setup();
      selectWork();
      highPriority();
      title('New task');
      fireEvent.keyDown(screen.getByTestId('composer-title'), key);
      await waitFor(() =>
        expect(createItem).toHaveBeenCalledWith({
          folder: 'records/work-items',
          slug: 'new-task',
          frontmatter: { type: 'Work item', status: 'todo', priority: 'high' },
          body: '# New task\n',
        }),
      );
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(navigate).toHaveBeenCalledWith({
        kind: 'doc',
        path: 'records/work-items/new-task.md',
      });
    },
  );

  it('a blank title gives a correction and writes nothing', () => {
    const { createItem } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Create record' }));
    expect(screen.getByRole('alert').textContent).toBe('Give it a title');
    expect(createItem).not.toHaveBeenCalled();
  });

  it('a scalar edit committed by Ctrl+Enter is included in that same create', async () => {
    const entries = [...useVaultStore.getState().entries];
    const work = entries.find((entry) => entry.type === 'Type' && entry.title === 'Work item')!;
    work.properties.fields = {
      ...(work.properties.fields as object),
      estimate: { kind: 'number' },
    } as never;
    work.properties.layout = { heading: ['estimate'] } as never;
    useVaultStore.setState({ entries });
    const { createItem } = setup();
    selectWork();
    title('Estimate this');
    fireEvent.click(
      within(screen.getByTestId('heading-strip')).getByRole('button', { name: 'Empty' }),
    );
    const estimate = screen.getByRole('textbox', { name: 'Estimate' });
    fireEvent.change(estimate, { target: { value: '8' } });
    fireEvent.keyDown(estimate, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
    expect(createItem.mock.calls[0][0].frontmatter).toMatchObject({ estimate: 8 });
  });

  it('Create more keeps fields, clears and refocuses the title, and stays open', async () => {
    const { createItem, onClose, navigate } = setup();
    selectWork();
    highPriority();
    fireEvent.click(screen.getByTestId('composer-create-more'));
    title('Alpha');
    fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('composer-title')).toHaveProperty('value', ''));
    expect(document.activeElement).toBe(screen.getByTestId('composer-title'));
    expect(screen.getByRole('button', { name: 'High' })).toBeTruthy();
    title('Beta');
    fireEvent.click(screen.getByRole('button', { name: 'Create record' }));
    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(2));
    expect(createItem.mock.calls[1][0].frontmatter).toMatchObject({
      priority: 'high',
      status: 'todo',
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.map((toast) => toast.message)).toContain('Created “Alpha”');
  });

  it('keeps a failed draft editable and ignores duplicate submits while pending', async () => {
    let reject!: (error: Error) => void;
    const createItem = vi.fn(
      () =>
        new Promise<string>((_, no) => {
          reject = no;
        }),
    );
    const { onClose } = setup(createItem);
    title('Keep this');
    fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter', metaKey: true });
    fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter', metaKey: true });
    expect(createItem).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error('disk full')));
    expect(screen.getByTestId('composer-title')).toHaveProperty('value', 'Keep this');
    expect(screen.getByRole('button', { name: 'Create record' })).toHaveProperty('disabled', false);
    expect(useUiStore.getState().toasts.map((toast) => toast.message)).toContain(
      "Couldn't create “Keep this”",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows similar records and clicking one opens its page without creating', () => {
    const entry = useVaultStore.getState().entries.find((row) => row.type === 'Work item')!;
    content = {
      status: 'ready',
      result: {
        hits: [{ path: entry.path, title: entry.title, type: entry.type, parts: [] }],
        total: 1,
        widened: false,
        capped: 0,
      },
    };
    const { createItem, navigate, onClose } = setup();
    selectWork();
    fireEvent.click(screen.getByTestId('similar-record'));
    expect(navigate).toHaveBeenCalledWith({ kind: 'doc', path: entry.path });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(createItem).not.toHaveBeenCalled();
  });

  it.each(['idle', 'pending', 'unavailable'] as const)(
    'search %s neither invents results nor blocks creation',
    async (status) => {
      content = { status };
      const { createItem } = setup();
      expect(screen.queryByTestId('similar-records')).toBeNull();
      expect(screen.queryByTestId('similar-unavailable') !== null).toBe(status === 'unavailable');
      title('New task');
      fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter' });
      await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
    },
  );

  it('stores neither draft nor choices and closes on a vault change', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { onClose, createItem } = setup();
    selectWork();
    highPriority();
    title('Unsaved');
    fireEvent.click(screen.getByTestId('composer-create-more'));
    expect(setItem).not.toHaveBeenCalled();
    act(() => useVaultStore.setState({ vaultPath: '/other' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter' });
    expect(createItem).not.toHaveBeenCalled();
  });

  it('a create finishing after the composer closes cannot reopen or navigate', async () => {
    let resolve!: (path: string) => void;
    const createItem = vi.fn(
      () =>
        new Promise<string>((yes) => {
          resolve = yes;
        }),
    );
    const { unmount, navigate, onClose } = setup(createItem);
    title('Detached create');
    fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter' });
    unmount();
    await act(async () => resolve('records/people/detached-create.md'));
    expect(navigate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
