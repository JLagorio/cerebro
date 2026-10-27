// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewDocDialog } from './CreateMenu';
import { useVaultStore } from '@/stores/vaultStore';
import {
  clearCreationDraftsForVault,
  readCreationDraft,
  readCreationSubmission,
  saveCreationDraft,
} from '@/stores/creationDraftStore';
import { chooseOption } from '@/test/chooseOption';
import type { CreationContext } from '@/engine/creationDestination';
const context: CreationContext = {
  vault: '/pages-tests',
  pane: 'p1',
  destination: { kind: 'page', folder: '', recipe: { kind: 'blank' } },
};
const sheet: CreationContext = {
  ...context,
  destination: { kind: 'page', folder: '', recipe: { kind: 'sheet', sheetName: 'Sheet1' } },
};
beforeEach(() => {
  clearCreationDraftsForVault(context.vault);
  useVaultStore.setState({
    vaultPath: context.vault,
    entriesVault: context.vault,
    status: 'ready',
    entries: [],
    folders: ['notes'],
  });
});
afterEach(cleanup);
const title = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText(/Page title|Name the page/), { target: { value } });
it.each([false, true])(
  'plain_page_draft_never_resumes_as_sheet / sheet_draft_never_resumes_as_plain_page (%s)',
  (isSheet) => {
    const first = render(<NewDocDialog sheet={isSheet} onClose={vi.fn()} />);
    title('  Session text  ');
    first.unmount();
    const other = render(<NewDocDialog sheet={!isSheet} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.getByPlaceholderText(/Page title|Name the page/)).toHaveProperty('value', '');
    other.unmount();
    render(<NewDocDialog sheet={isSheet} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByPlaceholderText(/Page title|Name the page/)).toHaveProperty(
      'value',
      '  Session text  ',
    );
  },
);
it('create_more_preserves_recipe even if the mounted sheet prop changes', async () => {
  const writer = vi.fn().mockResolvedValue('sheet.md');
  useVaultStore.setState({ createItem: writer });
  const view = render(<NewDocDialog sheet onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Create more' }));
  title('One');
  view.rerender(<NewDocDialog sheet={false} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() =>
    expect(screen.getByPlaceholderText('Name the page')).toHaveProperty('value', ''),
  );
  title('Two');
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  await waitFor(() => expect(writer).toHaveBeenCalledTimes(2));
  for (const [request] of writer.mock.calls) expect(request.body).toContain('```cerebro-sheet\n');
});
it('pending_recipe_isolation retains stable IDs across close and Resume', async () => {
  const resolves: ((path: string) => void)[] = [];
  const writer = vi.fn(() => new Promise<string>((resolve) => resolves.push(resolve)));
  useVaultStore.setState({ createItem: writer });
  const plain = render(<NewDocDialog onClose={vi.fn()} />);
  title('Plain');
  fireEvent.click(screen.getByRole('button', { name: 'Create page' }));
  plain.unmount();
  const plainId = readCreationSubmission(context)?.id;
  const workbook = render(<NewDocDialog sheet onClose={vi.fn()} />);
  title('Sheet');
  fireEvent.click(screen.getByRole('button', { name: 'Create' }));
  workbook.unmount();
  expect(readCreationSubmission(sheet)?.id).not.toBe(plainId);
  render(<NewDocDialog onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(screen.getByRole('button', { name: 'Creating…' })).toHaveProperty('disabled', true);
  expect(writer).toHaveBeenCalledTimes(2);
  await act(async () => {
    resolves[0]('plain.md');
    resolves[1]('sheet.md');
  });
  expect(readCreationDraft(context)).toBeNull();
  expect(readCreationDraft(sheet)).toBeNull();
});
it('does not resurrect a completed page snapshot when opening another new page', async () => {
  useVaultStore.setState({ createItem: vi.fn().mockResolvedValue('finished.md') });
  const first = render(<NewDocDialog onClose={vi.fn()} />);
  title('Finished');
  fireEvent.click(screen.getByRole('button', { name: 'Create page' }));
  await waitFor(() => expect(readCreationSubmission(context)?.state).toBe('succeeded'));
  first.unmount();
  render(<NewDocDialog onClose={vi.fn()} />);
  expect(screen.getByPlaceholderText('Page title')).toHaveProperty('value', '');
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
});
it('a second owner cannot edit or discard the first composer draft and can Resume after it closes', () => {
  const first = render(<NewDocDialog onClose={vi.fn()} />);
  title('Owned by first');
  const second = render(<NewDocDialog onClose={vi.fn()} />);
  const dialogs = screen.getAllByRole('dialog');
  const other = dialogs[1];
  expect(within(other).queryByPlaceholderText('Page title')).toBeNull();
  expect(within(other).getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', true);
  first.unmount();
  fireEvent.click(within(other).getByRole('button', { name: 'Resume' }));
  expect(within(other).getByPlaceholderText('Page title')).toHaveProperty(
    'value',
    'Owned by first',
  );
  second.unmount();
});
it.each(
  [false, true].flatMap((sheet) =>
    [false, true].flatMap((resumeBeforeAck) =>
      [false, true].map((more) => ({ sheet, resumeBeforeAck, more })),
    ),
  ),
)(
  'consumes resumed acknowledgement (sheet=$sheet, resumeBeforeAck=$resumeBeforeAck, more=$more)',
  async (scenario) => {
    let finish!: (path: string) => void;
    const writer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    useVaultStore.setState({ createItem: writer });
    const first = render(<NewDocDialog sheet={scenario.sheet} onClose={vi.fn()} />);
    if (scenario.more) fireEvent.click(screen.getByRole('checkbox', { name: 'Create more' }));
    title('Already created');
    fireEvent.click(
      screen.getByRole('button', { name: scenario.sheet ? 'Create' : 'Create page' }),
    );
    first.unmount();
    const close = vi.fn();
    render(<NewDocDialog sheet={scenario.sheet} onClose={close} />);
    if (scenario.resumeBeforeAck) fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await act(async () => finish('created.md'));
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(
      screen.getByPlaceholderText(scenario.sheet ? 'Name the page' : 'Page title'),
    ).toHaveProperty('value', '');
    fireEvent.click(
      screen.getByRole('button', { name: scenario.sheet ? 'Create' : 'Create page' }),
    );
    expect(writer).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Create more' })).toHaveProperty(
      'checked',
      scenario.more,
    );
  },
);
it('shows the proposed page folder before confirming and keeps both contexts untouched', () => {
  render(<NewDocDialog onClose={vi.fn()} />);
  title('Move title');
  chooseOption(screen.getByRole('button', { name: 'Folder' }), 'notes');
  expect(screen.getByRole('region', { name: 'Change draft destination' }).textContent).toContain(
    'notes',
  );
  expect(readCreationDraft(context)?.title).toBe('Move title');
  expect(
    readCreationDraft({
      ...context,
      destination: { kind: 'page', folder: 'notes', recipe: { kind: 'blank' } },
    }),
  ).toBeNull();
});
it.each(['succeeded', 'failed'] as const)(
  'resumed $0 acknowledgement preserves a newer scoped draft',
  async (outcome) => {
    let finish!: (path: string) => void;
    let fail!: (error: Error) => void;
    useVaultStore.setState({
      createItem: vi.fn(
        () =>
          new Promise<string>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      ),
    });
    const first = render(<NewDocDialog onClose={vi.fn()} />);
    title('Original');
    fireEvent.click(screen.getByRole('button', { name: 'Create page' }));
    first.unmount();
    render(<NewDocDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    const pending = readCreationDraft(context)!;
    act(() =>
      saveCreationDraft({
        ...pending,
        revision: pending.revision + 1,
        title: 'Newer input',
        formError: null,
      }),
    );
    await act(async () => {
      if (outcome === 'succeeded') finish('created.md');
      else fail(Error('Original failure'));
    });
    expect(screen.getByPlaceholderText('Page title')).toHaveProperty('value', 'Newer input');
    expect(readCreationDraft(context)?.title).toBe('Newer input');
    expect(readCreationDraft(context)?.formError).toBeNull();
  },
);
it.each(
  [false, true].flatMap((afterSubmit) =>
    ['succeeded', 'failed'].flatMap((outcome) =>
      [false, true].map((newer) => ({ afterSubmit, outcome, newer })),
    ),
  ),
)(
  'waiting owner takes live state after acknowledgement (afterSubmit=$afterSubmit, outcome=$outcome, newer=$newer)',
  async ({ afterSubmit, outcome, newer }) => {
    let finish!: (path: string) => void;
    let fail!: (error: Error) => void;
    const writer = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      )
      .mockResolvedValue('next.md');
    useVaultStore.setState({ createItem: writer });
    const first = render(<NewDocDialog onClose={vi.fn()} />);
    title('  Acknowledged once  ');
    const firstDialog = screen.getByRole('dialog');
    if (afterSubmit)
      fireEvent.click(within(firstDialog).getByRole('button', { name: 'Create page' }));
    render(<NewDocDialog onClose={vi.fn()} />);
    const waiting = screen.getAllByRole('dialog')[1];
    if (!afterSubmit)
      fireEvent.click(within(firstDialog).getByRole('button', { name: 'Create page' }));
    if (newer) {
      const original = readCreationDraft(context)!;
      act(() =>
        saveCreationDraft({
          ...original,
          revision: original.revision + 1,
          title: 'Newer input',
          formError: null,
        }),
      );
    }
    await act(async () => {
      if (outcome === 'succeeded') finish('created.md');
      else fail(Error('write refused'));
    });
    first.unmount();
    fireEvent.click(within(waiting).getByRole('button', { name: 'Resume' }));
    const expected = newer ? 'Newer input' : outcome === 'succeeded' ? '' : '  Acknowledged once  ';
    expect(within(waiting).getByPlaceholderText('Page title')).toHaveProperty('value', expected);
    expect(writer).toHaveBeenCalledTimes(1);
    if (outcome === 'succeeded' && !newer) {
      fireEvent.click(within(waiting).getByRole('button', { name: 'Create page' }));
      expect(writer).toHaveBeenCalledTimes(1);
    } else if (outcome === 'failed' && !newer)
      expect(within(waiting).getByRole('alert').textContent).toBe('write refused');
    else expect(within(waiting).queryByRole('alert')).toBeNull();
  },
);
