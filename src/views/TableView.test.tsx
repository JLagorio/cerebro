import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TableView } from '@/views/TableView';
import { buildSchema } from '@/engine/schema';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';
import type { Presentation } from '@/engine/types';

const presentation: Presentation = {
  type: 'table',
  group: [],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'status' }, { field: 'priority' }],
  hierarchy: [],
};

function setup() {
  const entries = fixtureVault();
  useVaultStore.setState({ entries });
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.type === 'Work item');
  const fields = schema.types.get('Work item')?.fields ?? [];
  render(
    <TableView entries={items} presentation={presentation} schema={schema} fields={fields} />,
  );
  return { items };
}

afterEach(cleanup);

describe('TableView row opening (M9.3)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ detailPath: null });
    // Standing in a saved view — the case that used to navigate away.
    useNavStore.setState({
      selection: { kind: 'view', id: 'at-risk-work' },
      history: [{ kind: 'view', id: 'at-risk-work' }],
      historyIndex: 0,
    });
  });

  it('opens a work item in the detail panel without leaving the view', async () => {
    const user = userEvent.setup();
    const { items } = setup();
    const item = items[0];

    await user.click(screen.getByLabelText(`Open ${item.title}`));

    expect(useUiStore.getState().detailPath).toBe(item.path);
    // The regression: this used to become { kind: 'project', … }.
    expect(useNavStore.getState().selection).toEqual({ kind: 'view', id: 'at-risk-work' });
  });

  it('still navigates when the row is a Project record', async () => {
    const user = userEvent.setup();
    const entries = fixtureVault();
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    const project = entries.find((e) => e.type === 'Project')!;
    render(
      <TableView
        entries={[project]}
        presentation={presentation}
        schema={schema}
        fields={schema.types.get('Project')?.fields ?? []}
      />,
    );

    await user.click(screen.getByLabelText(`Open ${project.title}`));

    // A project is a page, not a panel — it is the one kind that still moves.
    expect(useNavStore.getState().selection).toEqual({ kind: 'project', path: project.path });
  });
});
