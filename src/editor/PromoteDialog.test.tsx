// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseOption, optionLabels } from '@/test/chooseOption';
import { fixtureVault, makeEntry } from '@/test/factories';
import { useVaultStore } from '@/stores/vaultStore';
import type { ChecklistLine } from '@/engine/promote';
import * as actions from '@/app/promoteActions';
import { PromoteDialog } from './PromoteDialog';

const lines: ChecklistLine[] = ['First', 'Second'].map((title) => ({
  blockId: title,
  checked: false,
  title,
  due: null,
  extraDates: [],
  people: [],
  flattened: false,
  onlyLink: false,
  text: title,
  snapshot: '',
}));
beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem('cerebro.promoteTarget');
  useVaultStore.setState({ entries: fixtureVault(), vaultPath: '/vault', entriesVault: '/vault' });
});
afterEach(cleanup);

describe('PromoteDialog', () => {
  it('reports each line and links only after creation, then offers Done', async () => {
    const result: actions.PromotionResult[] = [
      { line: lines[0], outcome: 'created', path: 'first.md', notes: [] },
      { line: lines[1], outcome: 'failed', reason: 'Disk full' },
    ];
    const create = vi.spyOn(actions, 'createPromoted').mockResolvedValue(result);
    const onCreated = vi.fn((rows) => rows);
    const onClose = vi.fn();
    render(<PromoteDialog lines={lines} source={null} onCreated={onCreated} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Promote 2 lines' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      screen.getAllByTestId('promote-result').map((row) => row.getAttribute('data-outcome')),
    ).toEqual(['created', 'failed']);
    expect(screen.getByText('Disk full')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('remembers the target and offers only ambiguous person and parent mappings', () => {
    const entries = fixtureVault();
    const work = entries.find((entry) => entry.type === 'Type' && entry.title === 'Work item')!;
    work.properties.fields = {
      ...(work.properties.fields as object),
      reviewer: { kind: 'person' },
      parent: { kind: 'relation', target: 'Work item', limit: 1 },
      feature: { kind: 'relation', target: 'Work item', limit: 1 },
    } as never;
    entries.push(
      makeEntry({
        path: 'types/issue.md',
        type: 'Type',
        title: 'Issue',
        properties: { fields: { state: { kind: 'status' } } } as never,
      }),
    );
    useVaultStore.setState({ entries });
    const source = entries.find((entry) => entry.type === 'Work item')!;
    const view = render(
      <PromoteDialog lines={lines} source={source} onCreated={(rows) => rows} onClose={vi.fn()} />,
    );
    expect(screen.queryByTestId('promote-person')).toBeNull();
    const database = screen.getByRole('button', { name: 'Database' });
    expect(database.getAttribute('data-value')).toBe('Issue');
    chooseOption(database, 'Work item');
    expect(localStorage.getItem('cerebro.promoteTarget')).toBe('Work item');
    expect(screen.getByRole('button', { name: 'People' })).toBe(
      screen.getByTestId('promote-person'),
    );
    const parent = screen.getByRole('button', { name: 'Parent' });
    expect(parent).toBe(screen.getByTestId('promote-parent'));
    expect(parent.getAttribute('data-value')).toBe('');
    expect(optionLabels(parent)).toEqual(['No parent', 'Parent', 'Feature']);
    chooseOption(parent, 'Feature');
    expect(parent.getAttribute('data-value')).toBe('feature');
    view.unmount();
    render(
      <PromoteDialog lines={lines} source={source} onCreated={(rows) => rows} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId('promote-target').getAttribute('data-value')).toBe('Work item');
  });

  it('names an unavailable status capability and cannot promote', () => {
    useVaultStore.setState({ entries: [makeEntry({ path: 'note.md' })] });
    render(
      <PromoteDialog lines={lines} source={null} onCreated={(rows) => rows} onClose={vi.fn()} />,
    );
    expect(screen.getByTestId('promote-none').textContent).toBe(
      'No database tracks status yet. Add a Status property to one first.',
    );
    expect(screen.getByRole('button', { name: 'Promote 2 lines' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('a pending create never rewrites the old editor after a vault switch', async () => {
    let resolve!: (value: actions.PromotionResult[]) => void;
    vi.spyOn(actions, 'createPromoted').mockImplementation(
      () =>
        new Promise((yes) => {
          resolve = yes;
        }),
    );
    const onCreated = vi.fn((rows) => rows);
    const onClose = vi.fn();
    render(<PromoteDialog lines={lines} source={null} onCreated={onCreated} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Promote 2 lines' }));
    act(() => useVaultStore.setState({ vaultPath: '/other' }));
    await act(async () =>
      resolve([{ line: lines[0], outcome: 'created', path: 'first.md', notes: [] }]),
    );
    expect(onClose).toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
