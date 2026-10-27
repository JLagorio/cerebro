// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVault } from '@/test/factories';
import { getSchema } from '@/stores/vaultStore';
import { CreationDestinationField } from './CreationDestinationField';
afterEach(cleanup);
it('shows the actual database home and related host before creation', () => {
  const entries = fixtureVault();
  const host = entries.find((e) => e.type === 'Project')!;
  render(
    <CreationDestinationField
      destination={{
        kind: 'record',
        typeName: 'Work item',
        host: { path: host.path, field: 'project' },
        group: null,
      }}
      entries={entries}
      schema={getSchema(entries)}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByTestId('creation-destination').textContent).toContain('records/work-items');
  expect(screen.getByTestId('creation-destination').textContent).toContain(host.title);
});
it('keeps a missing folder visible as a repair rather than silently proposing root', () => {
  render(
    <CreationDestinationField
      destination={{ kind: 'page', folder: 'removed', recipe: { kind: 'blank' } }}
      entries={[]}
      schema={getSchema([])}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByText(/Choose a folder/)).toBeTruthy();
  expect(screen.getByTestId('creation-destination').textContent).toContain('removed');
});
