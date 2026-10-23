import * as ipc from '@/lib/ipc';
import { useUiStore } from '@/stores/uiStore';
import { useNavStore } from '@/stores/navStore';
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { MyWorkPage } from './MyWorkPage';

const TYPE_DOC = makeEntry({
  path: 'types/task.md',
  title: 'Task',
  type: 'Type',
  properties: {
    fields: { status: { kind: 'status' } },
    statuses: [
      { id: 'todo', label: 'To do', group: 'active' },
      { id: 'done', label: 'Done', group: 'done' },
    ],
  } as unknown as Entry['properties'],
});

describe('MyWorkPage', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: [] });
  });
  afterEach(cleanup);

  it('groups open work by database and shows the status label', () => {
    useVaultStore.setState({
      entries: [
        TYPE_DOC,
        makeEntry({
          path: 'records/tasks/fix-login.md',
          title: 'Fix login',
          type: 'Task',
          properties: { status: 'todo' } as unknown as Entry['properties'],
        }),
      ],
    });
    render(<MyWorkPage />);
    expect(screen.getByRole('heading', { name: 'My work' })).toBeTruthy();
    expect(screen.getByText('Task')).toBeTruthy();
    expect(screen.getByRole('option', { name: /Fix login/ })).toBeTruthy();
    expect(screen.getByText('To do')).toBeTruthy();
  });

  it('says the empty state in words, never a zero', () => {
    useVaultStore.setState({ entries: [TYPE_DOC] });
    render(<MyWorkPage />);
    expect(screen.getByText(/Nothing is in progress/)).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });
});

it('renders overdue count and a red deadline chip before database work (M61.3b)', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 28, 12));
  try {
    const doc = makeEntry({
      ...TYPE_DOC,
      properties: {
        ...TYPE_DOC.properties,
        deadline: 'due',
        fields: { status: { kind: 'status' }, due: { kind: 'date' } },
      } as never,
    });
    useVaultStore.setState({
      entries: [
        doc,
        makeEntry({
          path: 'late.md',
          title: 'Late work',
          type: 'Task',
          properties: { status: 'todo', due: '2026-07-24' },
        }),
        makeEntry({
          path: 'today.md',
          title: 'Today work',
          type: 'Task',
          properties: { status: 'todo', due: '2026-07-28' },
        }),
      ],
    });
    render(<MyWorkPage />);
    const section = screen.getAllByTestId('mywork-section')[0];
    expect(section.getAttribute('data-bucket')).toBe('overdue');
    expect(section.textContent).toContain('Overdue1');
    const chips = screen.getAllByTestId('mywork-deadline');
    expect(chips[0].textContent).toBe('Jul 24');
    expect(chips[0].className).toContain('text-danger-600');
    expect(chips[1].className).toContain('text-warn-700');
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});

it('moves across sections, peeks in place, and steps the open peek', () => {
  const rows = ['Alpha', 'Beta', 'Gamma'].map((title) =>
    makeEntry({ path: `${title}.md`, title, type: 'Task', properties: { status: 'todo' } }),
  );
  useVaultStore.setState({ entries: [TYPE_DOC, ...rows] });
  useNavStore.setState({ selection: { kind: 'mywork' } });
  useUiStore.setState({ detailPath: null, detailSiblings: [] });
  render(<MyWorkPage />);
  fireEvent.keyDown(document.body, { key: 'j' });
  fireEvent.keyDown(document.activeElement!, { key: 'j' });
  fireEvent.keyDown(document.activeElement!, { key: 'Enter' });
  expect(useUiStore.getState().detailPath).toBe('Beta.md');
  expect(useNavStore.getState().selection.kind).toBe('mywork');
  fireEvent.keyDown(document.activeElement!, { key: 'j' });
  expect(useUiStore.getState().detailPath).toBe('Gamma.md');
  fireEvent.keyDown(document.activeElement!, { key: 'x' });
  expect(screen.getByTestId('list-selection').textContent).toContain('1 selected');
});

it('copies the selected page links from My work', async () => {
  const copy = vi.spyOn(ipc, 'writeClipboard').mockResolvedValue();
  useVaultStore.setState({
    entries: [
      TYPE_DOC,
      makeEntry({ path: 'task.md', title: 'A task', type: 'Task', properties: { status: 'todo' } }),
    ],
  });
  useUiStore.setState({ detailPath: null, detailSiblings: [] });
  render(<MyWorkPage />);
  fireEvent.keyDown(document.body, { key: 'j' });
  fireEvent.keyDown(document.activeElement!, { key: 'x' });
  fireEvent.click(screen.getByRole('button', { name: 'Copy links' }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith('[[task]]'));
  copy.mockRestore();
});
