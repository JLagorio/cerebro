// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { fixtureVault, makeEntry } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
import type { ContentSearch } from './useContentSearch';
import { RecordComposer } from './RecordComposer';
import {
  clearCreationDraftsForVault,
  readCreationDraft,
  readCreationSubmission,
} from '@/stores/creationDraftStore';

let content: ContentSearch = { status: 'idle' };
vi.mock('./useContentSearch', () => ({ useContentSearch: () => content }));

beforeEach(() => {
  vi.restoreAllMocks();
  clearCreationDraftsForVault('/vault');
  content = { status: 'idle' };
  const entries = fixtureVault();
  const work = entries.find((entry) => entry.type === 'Type' && entry.title === 'Work item')!;
  work.properties.layout = { heading: ['status', 'priority'] } as never;
  entries.push(
    ...['Collection', 'Agent', 'Skill'].map((title) =>
      makeEntry({ path: `types/${title}.md`, title, type: 'Type' }),
    ),
  );
  useVaultStore.setState({ entries, vaultPath: '/vault', entriesVault: '/vault', status: 'ready' });
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
const selectWork = () => chooseOption(screen.getByTestId('composer-database'), 'Work item');
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

  it('excludes reserved databases and retains scoped field values across database switches', () => {
    setup();
    const database = screen.getByRole('button', { name: 'Database' });
    expect(database).toBe(screen.getByTestId('composer-database'));
    expect(optionLabels(database)).toEqual(['Person', 'Project', 'Work item']);
    selectWork();
    highPriority();
    expect(screen.getByRole('button', { name: 'High' })).toBeTruthy();
    chooseOption(database, 'Project');
    fireEvent.click(screen.getByRole('button', { name: 'Leave draft and start here' }));
    expect(database.getAttribute('data-value')).toBe('Project');
    expect(screen.queryByTestId('heading-strip')).toBeNull();
    selectWork();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByRole('button', { name: 'High' })).toBeTruthy();
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

  it('Mod+Enter in a different database asks for explicit draft transfer before creating', async () => {
    const { createItem } = setup();
    title('New task');
    const database = screen.getByTestId('composer-database');
    fireEvent.click(database);
    fireEvent.keyDown(database, { key: 'End' });
    fireEvent.keyDown(database, { key: 'Enter', metaKey: true });
    expect(createItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Move draft here' }));
    fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter', metaKey: true });
    await waitFor(() =>
      expect(createItem).toHaveBeenCalledWith({
        folder: 'records/work-items',
        slug: 'new-task',
        frontmatter: { type: 'Work item' },
        body: '# New task\n',
      }),
    );
  });

  it('a blank title gives a correction and writes nothing', () => {
    const { createItem } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Create record' }));
    expect(screen.getByRole('alert').textContent).toBe('Give it a title');
    expect(createItem).not.toHaveBeenCalled();
  });

  it.each([
    { modifier: 'Ctrl', ctrlKey: true, metaKey: false, value: '8', valid: true },
    { modifier: 'Cmd', ctrlKey: false, metaKey: true, value: '8', valid: true },
    { modifier: 'Ctrl', ctrlKey: true, metaKey: false, value: 'Infinity', valid: false },
    { modifier: 'Cmd', ctrlKey: false, metaKey: true, value: 'Infinity', valid: false },
  ])('$modifier+Enter settles a scalar draft before create ($value)', async (scenario) => {
    const entries = [...useVaultStore.getState().entries];
    const work = entries.find((entry) => entry.type === 'Type' && entry.title === 'Work item')!;
    work.properties.fields = {
      ...(work.properties.fields as object),
      estimate: { kind: 'number' },
    } as never;
    work.properties.layout = { heading: ['estimate'] } as never;
    useVaultStore.setState({ entries });
    const { createItem, onClose } = setup();
    selectWork();
    title('Estimate this');
    fireEvent.click(
      within(screen.getByTestId('heading-strip')).getByRole('button', { name: 'Empty' }),
    );
    const estimate = screen.getByRole('textbox', { name: 'Estimate' });
    fireEvent.change(estimate, { target: { value: scenario.value } });
    fireEvent.keyDown(estimate, {
      key: 'Enter',
      ctrlKey: scenario.ctrlKey,
      metaKey: scenario.metaKey,
    });
    if (scenario.valid) {
      await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
      expect(createItem.mock.calls[0][0].frontmatter).toMatchObject({ estimate: 8 });
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    } else {
      expect(createItem).not.toHaveBeenCalled();
      expect((estimate as HTMLInputElement).value).toBe('Infinity');
      expect(screen.getByRole('status').textContent).toBe('Enter a finite number.');
    }
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
    expect(screen.getByRole('alert').textContent).toBe('disk full');
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

  it('keeps draft bytes in memory only and closes on a vault change', async () => {
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

const personContext = {
  vault: '/vault',
  pane: 'p1' as const,
  destination: { kind: 'record' as const, typeName: 'Person', host: null, group: null },
};
it('Cancel keeps exact title and Resume restores it only in the original context', () => {
  const first = setup();
  title('  Keep whitespace  ');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  first.unmount();
  expect(readCreationDraft(personContext)?.title).toBe('  Keep whitespace  ');
  setup();
  expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(screen.getByTestId('composer-title')).toHaveProperty('value', '  Keep whitespace  ');
});
it('close then Resume before acknowledgement blocks another create and settles the original ID', async () => {
  let resolve!: (path: string) => void;
  const writer = vi.fn(
    () =>
      new Promise<string>((yes) => {
        resolve = yes;
      }),
  );
  const first = setup(writer);
  title('Only once');
  fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter' });
  const id = readCreationSubmission(personContext)?.id;
  first.unmount();
  const second = setup(writer);
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(screen.getByRole('button', { name: 'Creating…' })).toHaveProperty('disabled', true);
  fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter', metaKey: true });
  expect(writer).toHaveBeenCalledTimes(1);
  await act(async () => resolve('records/people/only-once.md'));
  expect(readCreationSubmission(personContext)?.id).toBe(id);
  expect(readCreationDraft(personContext)).toBeNull();
  expect(second.navigate).not.toHaveBeenCalled();
});
it('IME Enter never submits', () => {
  const { createItem } = setup();
  title('Composing');
  fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter', isComposing: true });
  fireEvent.keyDown(screen.getByTestId('composer-title'), {
    key: 'Enter',
    metaKey: true,
    isComposing: true,
  });
  expect(createItem).not.toHaveBeenCalled();
});
it('schema or host removal retains exact scoped input and offers destination repair', async () => {
  const entries = useVaultStore.getState().entries;
  const context = {
    ...personContext,
    destination: {
      kind: 'record' as const,
      typeName: 'Work item',
      host: { path: 'missing-host.md', field: 'project' },
      group: null,
    },
  };
  const writer = vi.fn();
  useVaultStore.setState({ createItem: writer });
  render(<RecordComposer context={context} onClose={vi.fn()} />);
  title('  Repair me  ');
  act(() =>
    useVaultStore.setState({ entries: entries.filter((entry) => entry.title !== 'Work item') }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Create record' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/Choose a database/));
  expect(writer).not.toHaveBeenCalled();
  expect(readCreationDraft(context)?.title).toBe('  Repair me  ');
});
it('same-tick Enter plus click share one pending snapshot and acknowledgement clears it', async () => {
  let resolve!: (path: string) => void;
  const writer = vi.fn(
    () =>
      new Promise<string>((yes) => {
        resolve = yes;
      }),
  );
  setup(writer);
  title('Exactly one');
  act(() => {
    fireEvent.keyDown(screen.getByTestId('composer-title'), { key: 'Enter', metaKey: true });
    fireEvent.click(screen.getByRole('button', { name: /Create record|Creating/ }));
  });
  expect(writer).toHaveBeenCalledTimes(1);
  await act(async () => resolve('one.md'));
  expect(readCreationDraft(personContext)).toBeNull();
});
it('retains invalid uncommitted scalar text and its field correction through close and Resume', () => {
  const entries = [...useVaultStore.getState().entries];
  const work = entries.find((entry) => entry.type === 'Type' && entry.title === 'Work item')!;
  work.properties.fields = {
    ...(work.properties.fields as object),
    estimate: { kind: 'number' },
  } as never;
  work.properties.layout = { heading: ['estimate'] } as never;
  useVaultStore.setState({ entries });
  const first = setup();
  selectWork();
  title('Keep estimate');
  fireEvent.click(
    within(screen.getByTestId('heading-strip')).getByRole('button', { name: 'Empty' }),
  );
  fireEvent.change(screen.getByRole('textbox', { name: 'Estimate' }), {
    target: { value: '  Infinity  ' },
  });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Estimate' }), {
    key: 'Enter',
    metaKey: true,
  });
  expect(screen.getByRole('status').textContent).toBe('Enter a finite number.');
  first.unmount();
  setup();
  selectWork();
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(screen.getByRole('textbox', { name: 'Estimate' })).toHaveProperty('value', '  Infinity  ');
  expect(screen.getByRole('status').textContent).toBe('Enter a finite number.');
});
it.each(['removed', 'kind', 'layout'])(
  'exposes retained scalar after schema $0 change and discards only that value before continuing',
  async (change) => {
    const entries = structuredClone(useVaultStore.getState().entries);
    const work = entries.find((entry) => entry.type === 'Type' && entry.title === 'Work item')!;
    work.properties.fields = {
      ...(work.properties.fields as object),
      estimate: { kind: 'number' },
    } as never;
    work.properties.layout = { heading: ['estimate', 'priority'] } as never;
    useVaultStore.setState({ entries });
    const { createItem } = setup();
    selectWork();
    title('Keep title and priority');
    highPriority();
    const estimateCell = screen
      .getByTestId('heading-strip')
      .querySelector('[data-field="estimate"]') as HTMLElement;
    fireEvent.click(within(estimateCell).getByRole('button', { name: 'Empty' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Estimate' }), {
      target: { value: '  Infinity  ' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Estimate' }), { key: 'Enter' });
    act(() => {
      const changed = structuredClone(entries);
      const def = changed.find((entry) => entry.title === 'Work item')!;
      if (change === 'removed')
        delete (def.properties.fields as unknown as Record<string, unknown>).estimate;
      if (change === 'kind')
        (def.properties.fields as unknown as Record<string, unknown>).estimate = { kind: 'select' };
      if (change !== 'kind') def.properties.layout = { heading: ['priority'] } as never;
      useVaultStore.setState({ entries: changed });
    });
    expect(screen.getByText(/Infinity/)).toHaveProperty('textContent', '  Infinity  ');
    fireEvent.click(screen.getByRole('button', { name: 'Discard estimate value' }));
    expect(screen.getByTestId('composer-title')).toHaveProperty('value', 'Keep title and priority');
    expect(screen.getByRole('button', { name: 'High' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create record' }));
    await waitFor(() => expect(createItem).toHaveBeenCalledTimes(1));
    expect(createItem.mock.calls[0][0].frontmatter).toMatchObject({ priority: 'high' });
    expect(createItem.mock.calls[0][0].frontmatter).not.toHaveProperty('estimate');
  },
);
it('shows both the original and proposed database/home before an explicit transfer', () => {
  setup();
  selectWork();
  title('Review destination');
  chooseOption(screen.getByTestId('composer-database'), 'Person');
  const transfer = screen.getByRole('region', { name: 'Change draft destination' });
  expect(transfer.textContent).toContain('Work item');
  expect(transfer.textContent).toContain('Person');
  expect(transfer.textContent).toContain('records/persons');
});
it.each([false, true])(
  'resumed record acknowledgement consumes submitted values (more=$0)',
  async (more) => {
    let finish!: (path: string) => void;
    const writer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const first = setup(writer);
    selectWork();
    highPriority();
    title('Only once');
    if (more) fireEvent.click(screen.getByTestId('composer-create-more'));
    fireEvent.click(screen.getByRole('button', { name: 'Create record' }));
    first.unmount();
    const second = setup(writer);
    selectWork();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await act(async () => finish('created.md'));
    expect(screen.getByTestId('composer-title')).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'High' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create record' }));
    expect(writer).toHaveBeenCalledTimes(1);
    expect(second.navigate).not.toHaveBeenCalled();
  },
);
