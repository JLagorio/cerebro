// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelationPicker } from '@/detail/RelationPicker';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { Entry } from '@/engine/types';
import { useOpenLogStore } from '@/stores/openLogStore';
import { useNavStore } from '@/stores/navStore';
import { useVaultStore } from '@/stores/vaultStore';

const ENTRIES: Entry[] = [
  makeEntry({ path: 'types/objective.md', title: 'Objective', type: 'Type' }),
  makeEntry({ path: 'records/objectives/grow-eu.md', title: 'Grow EU revenue', type: 'Objective' }),
  makeEntry({ path: 'records/objectives/cut-churn.md', title: 'Cut churn', type: 'Objective' }),
  makeEntry({ path: 'records/objectives/hire.md', title: 'Hire two engineers', type: 'Objective' }),
  makeEntry({ path: 'records/risks/latency.md', title: 'Latency', type: 'Risk' }),
];

const schema = buildSchema(ENTRIES);

function setup(value: string[] = [], onChange = vi.fn()) {
  render(
    <RelationPicker
      fieldName="key_results"
      targetType="Objective"
      value={value}
      entries={ENTRIES}
      schema={schema}
      onChange={onChange}
      onClose={vi.fn()}
    />,
  );
  return onChange;
}

const rowTitles = (testId: string) =>
  screen.queryAllByTestId(testId).map((el) => el.textContent ?? '');

afterEach(cleanup);

describe('RelationPicker (M11)', () => {
  it('lists only records of the target type', () => {
    setup();
    const titles = rowTitles('relation-result-row').join(' ');
    expect(titles).toContain('Grow EU revenue');
    expect(titles).toContain('Cut churn');
    // A relation declares what it points at; offering a Risk here would let
    // you write a link the schema forbids.
    expect(titles).not.toContain('Latency');
  });

  it('shows what is already linked, separately from what could be', () => {
    setup(['grow-eu']);
    expect(rowTitles('relation-linked-row').join(' ')).toContain('Grow EU revenue');
    // Already linked, so it is not offered again in the search results.
    expect(rowTitles('relation-result-row').join(' ')).not.toContain('Grow EU revenue');
  });

  it('links a record by pressing its row', () => {
    const onChange = setup(['grow-eu']);
    fireEvent.click(screen.getByText('Cut churn'));
    expect(onChange).toHaveBeenCalledWith(['grow-eu', 'cut-churn']);
  });

  it('uses the folder as a project.md candidate id and recognizes it as linked', () => {
    const project = makeEntry({
      path: 'projects/atlas/project.md',
      title: 'Atlas project',
      type: 'Project',
    });
    const entries = [project];
    const onChange = vi.fn();
    const view = (value: string[]) => (
      <RelationPicker
        fieldName="project"
        targetType="Project"
        value={value}
        entries={entries}
        schema={buildSchema(entries)}
        onChange={onChange}
        onClose={vi.fn()}
      />
    );
    const { rerender } = render(view([]));
    fireEvent.click(screen.getByText('Atlas project'));
    expect(onChange).toHaveBeenCalledWith(['atlas']);
    rerender(view(['atlas']));
    expect(rowTitles('relation-linked-row').join(' ')).toContain('Atlas project');
    expect(rowTitles('relation-result-row')).toEqual([]);
  });

  it('unlinks from the linked list', () => {
    const onChange = setup(['grow-eu', 'cut-churn']);
    fireEvent.click(screen.getByLabelText('Unlink Cut churn'));
    expect(onChange).toHaveBeenCalledWith(['grow-eu']);
  });

  it('reorders linked records, because the order is what renders', () => {
    const onChange = setup(['grow-eu', 'cut-churn']);
    fireEvent.click(screen.getByLabelText('Move Cut churn up'));
    expect(onChange).toHaveBeenCalledWith(['cut-churn', 'grow-eu']);
  });

  it('pins the ends of the order — nothing moves off the list', () => {
    setup(['grow-eu', 'cut-churn']);
    expect(screen.getByLabelText('Move Grow EU revenue up')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Move Cut churn down')).toHaveProperty('disabled', true);
  });

  it('filters by title as you type', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Search records to link'), {
      target: { value: 'churn' },
    });
    const titles = rowTitles('relation-result-row').join(' ');
    expect(titles).toContain('Cut churn');
    expect(titles).not.toContain('Grow EU revenue');
  });

  it('Enter links the first match without leaving the keyboard', () => {
    const onChange = setup();
    const input = screen.getByLabelText('Search records to link');
    fireEvent.change(input, { target: { value: 'hire' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(['hire']);
  });

  it('offers to create a record that does not exist yet', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Search records to link'), {
      target: { value: 'Launch in Japan' },
    });
    expect(screen.getByTestId('relation-create')).toBeTruthy();
  });

  it('does not offer to create when the name already exists', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Search records to link'), {
      target: { value: 'Cut churn' },
    });
    expect(screen.queryByTestId('relation-create')).toBeNull();
  });

  it('shows a link whose target is gone rather than hiding it', () => {
    setup(['deleted-elsewhere']);
    const linked = rowTitles('relation-linked-row').join(' ');
    expect(linked).toContain('deleted-elsewhere');
    expect(linked).toContain('Not found in this vault');
  });

  it('says so when there is nothing left to link', () => {
    setup(['grow-eu', 'cut-churn', 'hire']);
    expect(screen.getByText(/already linked/)).toBeTruthy();
  });
});

// M59.3 — ranked by the one name ranker, uncapped.
describe('RelationPicker ranking (M59.3)', () => {
  beforeEach(() => {
    useVaultStore.setState({ vaultPath: '/v' });
    useOpenLogStore.setState({ logs: {}, saved: true });
  });

  it('lists a prefix match before a mid-title match', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Search records to link'), { target: { value: 'c' } });
    // 'Cut churn' starts with c; the other two hold one only inside their
    // paths (records/objectives/…).
    expect(rowTitles('relation-result-row')[0]).toContain('Cut churn');
  });

  it('lists your opened targets first on an empty query, then A to Z', () => {
    useOpenLogStore.getState().record('/v', 'records/objectives/hire.md');
    setup();
    const titles = rowTitles('relation-result-row');
    expect(titles[0]).toContain('Hire two engineers');
    expect(titles[1]).toContain('Cut churn');
    expect(titles[2]).toContain('Grow EU revenue');
  });
});

describe('RelationPicker confirm mode', () => {
  function setupConfirm(onConfirm = vi.fn().mockResolvedValue({ failed: new Map() })) {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <RelationPicker
        fieldName="Add existing"
        targetType="Objective"
        value={[]}
        entries={ENTRIES}
        schema={schema}
        onChange={onChange}
        onClose={onClose}
        confirm={{
          label: (n) => `Add ${n} records`,
          exclude: new Set([ENTRIES[1].path]),
          onConfirm,
        }}
      />,
    );
    return { onChange, onClose, onConfirm };
  }

  it('excludes filed rows, stages snapshots and counts without a live write or Create', async () => {
    const { onChange, onClose, onConfirm } = setupConfirm();
    expect(screen.queryByText('Grow EU revenue')).toBeNull();
    expect(screen.getByTestId('relation-picker-confirm')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByText('Cut churn'));
    fireEvent.click(screen.getByText('Hire two engineers'));
    expect(screen.getByText('Selected · 2')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText(/Links save as you make them/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Search records to link'), {
      target: { value: 'Brand new' },
    });
    expect(screen.queryByTestId('relation-create')).toBeNull();
    fireEvent.click(screen.getByTestId('relation-picker-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith([ENTRIES[2], ENTRIES[3]]));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('keeps only failed records staged and names the reason, then allows retry', async () => {
    const onConfirm = vi
      .fn()
      .mockResolvedValueOnce({
        failed: new Map([[ENTRIES[3].path, 'changed since the table showed it']]),
      })
      .mockResolvedValueOnce({ failed: new Map() });
    const { onClose } = setupConfirm(onConfirm);
    fireEvent.click(screen.getByText('Cut churn'));
    fireEvent.click(screen.getByText('Hire two engineers'));
    fireEvent.click(screen.getByTestId('relation-picker-confirm'));
    await waitFor(() => expect(screen.getByText('Selected · 1')).toBeTruthy());
    expect(rowTitles('relation-linked-row')).toHaveLength(1);
    expect(rowTitles('relation-linked-row')[0]).toContain('Hire two engineers');
    expect(screen.getByRole('alert').textContent).toContain(
      "1 couldn't be added. “Hire two engineers” changed since the table showed it.",
    );
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('relation-picker-confirm'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('Cancel writes nothing and removing a failed selection clears its error', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('failed'));
    const { onClose } = setupConfirm(onConfirm);
    fireEvent.click(screen.getByText('Cut churn'));
    fireEvent.click(screen.getByTestId('relation-picker-confirm'));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Unlink Cut churn'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('relation-picker-confirm')).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('retains the selected entry version after a scan replaces the candidate', async () => {
    const onConfirm = vi.fn().mockResolvedValue({ failed: new Map() });
    const props = {
      fieldName: 'Add existing',
      targetType: 'Objective',
      value: [],
      schema,
      onChange: vi.fn(),
      onClose: vi.fn(),
      confirm: { label: (n: number) => `Add ${n} records`, exclude: new Set<string>(), onConfirm },
    };
    const { rerender } = render(<RelationPicker {...props} entries={ENTRIES} />);
    fireEvent.click(screen.getByText('Cut churn'));
    rerender(
      <RelationPicker
        {...props}
        entries={ENTRIES.map((entry) =>
          entry.path === ENTRIES[2].path ? { ...entry, hash: 'new hash' } : entry,
        )}
      />,
    );
    fireEvent.click(screen.getByTestId('relation-picker-confirm'));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith([ENTRIES[2]]));
  });
});

describe('Agent library target (M63.3)', () => {
  const entries = [
    makeEntry({ path: 'agents/scout.md', title: 'Release scout', type: 'Agent' }),
    makeEntry({ path: 'agents/knowledge.md', title: 'Knowledge agent', type: 'Agent' }),
    makeEntry({ path: 'knowledge/planted.md', title: 'Planted agent', type: 'Agent' }),
    makeEntry({ path: 'templates/agent.md', title: 'Template agent', type: 'Agent' }),
    makeEntry({
      path: 'agents/broken.md',
      title: 'Broken agent',
      type: 'Agent',
      parseError: 'broken',
    }),
    makeEntry({ path: 'people/ana.md', title: 'Ana', type: 'Person' }),
  ];
  const setupAgent = () => {
    const onChange = vi.fn();
    render(
      <RelationPicker
        fieldName="agent"
        targetType="Agent"
        value={[]}
        entries={entries}
        schema={buildSchema(entries)}
        onChange={onChange}
        onClose={vi.fn()}
      />,
    );
    return onChange;
  };

  it('an untargeted relation never offers library records', () => {
    render(
      <RelationPicker
        fieldName="related"
        targetType={null}
        value={[]}
        entries={[
          ...entries,
          makeEntry({ path: 'skills/check.md', type: 'Skill', title: 'Check' }),
        ]}
        schema={buildSchema(entries)}
        onChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(rowTitles('relation-result-row')).toEqual(['AnaPerson · people']);
  });

  it('lists only valid agent pages and links the filename stem', () => {
    const onChange = setupAgent();
    const titles = rowTitles('relation-result-row').join(' ');
    expect(titles).toContain('Release scout');
    expect(titles).toContain('Knowledge agent');
    for (const name of ['Planted agent', 'Template agent', 'Broken agent', 'Ana'])
      expect(titles).not.toContain(name);
    fireEvent.click(screen.getByText('Release scout'));
    expect(onChange).toHaveBeenCalledWith(['scout']);
  });

  it('never offers creation, including Enter, and explains the Library door', () => {
    const createItem = vi.spyOn(useVaultStore.getState(), 'createItem');
    const onChange = setupAgent();
    expect(screen.getByTestId('relation-picker-library-hint').textContent).toContain(
      'Agents are made in the Library and start paused.',
    );
    const input = screen.getByPlaceholderText('Link an agent…');
    fireEvent.change(input, { target: { value: 'Nobody' } });
    expect(screen.queryByTestId('relation-create')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(createItem).not.toHaveBeenCalled();
    createItem.mockRestore();
  });
});

it('opens a linked Agent as its page', () => {
  const agent = makeEntry({ path: 'agents/scout.md', type: 'Agent', title: 'Scout' });
  const onClose = vi.fn();
  render(
    <RelationPicker
      fieldName="agent"
      targetType="Agent"
      value={['scout']}
      entries={[agent]}
      schema={buildSchema([agent])}
      onChange={vi.fn()}
      onClose={onClose}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open Scout' }));
  expect(onClose).toHaveBeenCalled();
  expect(useNavStore.getState().selection).toEqual({ kind: 'doc', path: 'agents/scout.md' });
});
