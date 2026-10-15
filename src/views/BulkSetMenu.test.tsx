import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BulkSetMenu } from './BulkSetMenu';
import { fixtureVault, makeEntry } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import { useVaultStore } from '@/stores/vaultStore';

beforeEach(() => useVaultStore.setState({ entries: fixtureVault(), patchFrontmatter: vi.fn() }));
function setup() {
  const all = fixtureVault();
  const entries = all.filter((entry) => entry.type === 'Work item');
  const apply = vi.fn(async () => undefined);
  render(
    <BulkSetMenu
      entries={entries}
      schema={buildSchema(all)}
      sourceType="Work item"
      onApply={apply}
    />,
  );
  fireEvent.click(screen.getByTestId('bulk-set'));
  fireEvent.click(screen.getByTestId('bulk-set-field-priority'));
  return apply;
}

it('stages a choice and writes only on Apply', async () => {
  const apply = setup();
  expect((screen.getByTestId('bulk-set-apply') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Empty' }));
  fireEvent.click(screen.getByText('Low'));
  expect(apply).not.toHaveBeenCalled();
  expect(useVaultStore.getState().patchFrontmatter).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('bulk-set-apply'));
  await waitFor(() => expect(apply).toHaveBeenCalledWith('priority', 'low'));
});

it('an explicit clear is a choice', async () => {
  const apply = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Clear value' }));
  fireEvent.click(screen.getByTestId('bulk-set-apply'));
  await waitFor(() => expect(apply).toHaveBeenCalledWith('priority', null));
});

it('Escape closes the nested relation picker and keeps the staged bulk value for Apply', async () => {
  const all = [
    makeEntry({
      path: 'types/work.md',
      type: 'Type',
      title: 'Work item',
      properties: { fields: { agent: { kind: 'relation', target: 'Agent' } } } as never,
    }),
    makeEntry({ path: 'tasks/a.md', type: 'Work item' }),
    makeEntry({ path: 'agents/release-scout.md', type: 'Agent', title: 'Release scout' }),
  ];
  useVaultStore.setState({ entries: all });
  const apply = vi.fn(async () => undefined);
  render(
    <BulkSetMenu
      entries={all.filter((entry) => entry.type === 'Work item')}
      schema={buildSchema(all)}
      sourceType="Work item"
      onApply={apply}
    />,
  );
  fireEvent.click(screen.getByTestId('bulk-set'));
  fireEvent.click(screen.getByTestId('bulk-set-field-agent'));
  fireEvent.click(screen.getByRole('button', { name: 'Edit Agent' }));
  fireEvent.click(screen.getByText('Release scout'));
  fireEvent.keyDown(screen.getByPlaceholderText('Link an agent…'), { key: 'Escape' });
  expect(screen.queryByTestId('relation-picker')).toBeNull();
  expect(screen.getByTestId('bulk-set-apply')).toBeTruthy();
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('bulk-set-apply'));
  await waitFor(() => expect(apply).toHaveBeenCalledWith('agent', ['[[release-scout]]']));
});
