import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { buildSchema } from '@/engine/schema';
import type { FieldDef } from '@/engine/types';
import { makeEntry } from '@/engine/testHelpers';
import { useVaultStore } from '@/stores/vaultStore';
import { RollupConfigEditor } from './RollupConfigEditor';

const projectType = makeEntry({
  path: 'types/project.md',
  type: 'Type',
  title: 'Project',
  properties: { fields: { tasks: { kind: 'relation', target: 'Work item' } } },
});
const workType = makeEntry({
  path: 'types/work-item.md',
  type: 'Type',
  title: 'Work item',
  properties: {
    fields: { status: 'status', completed: 'checkbox', effort: 'number', category: 'select' },
  },
});
const progress: FieldDef = {
  name: 'progress',
  kind: 'rollup',
  relation: 'tasks',
  calculate: 'percent_done',
};

beforeEach(() => useVaultStore.setState({ entries: [projectType, workType] }));

describe('RollupConfigEditor Percent done', () => {
  it('offers the calculation and writes its stored name', () => {
    const onChange = vi.fn();
    render(
      <RollupConfigEditor
        typeName="Project"
        def={{ ...progress, calculate: 'count' }}
        schema={buildSchema([projectType, workType])}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Calculation' }));
    fireEvent.click(screen.getByRole('option', { name: 'Percent done' }));
    expect(onChange).toHaveBeenCalledWith({ calculate: 'percent_done' });
  });

  it.each(['forward', 'reverse'])(
    '%s source offers only status and checkbox properties',
    (direction) => {
      const def: FieldDef =
        direction === 'forward'
          ? progress
          : { ...progress, relation: undefined, from: { type: 'Work item', field: 'project' } };
      const onChange = vi.fn();
      render(
        <RollupConfigEditor
          typeName="Project"
          def={def}
          schema={buildSchema([projectType, workType])}
          onChange={onChange}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Property to aggregate' }));
      expect(screen.getByRole('option', { name: 'Status' })).toBeTruthy();
      expect(screen.getByRole('option', { name: 'Completed' })).toBeTruthy();
      expect(screen.queryByRole('option', { name: 'Effort' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'Category' })).toBeNull();
      fireEvent.click(screen.getByRole('option', { name: 'Completed' }));
      expect(onChange).toHaveBeenCalledWith({ property: 'completed' });
    },
  );

  it('explains when the target has no status or checkbox', () => {
    const onlyText = makeEntry({ ...workType, properties: { fields: { description: 'text' } } });
    render(
      <RollupConfigEditor
        typeName="Project"
        def={progress}
        schema={buildSchema([projectType, onlyText])}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText('Percent done needs a status or checkbox property on Work item.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Property to aggregate' }));
    expect(screen.queryByRole('option', { name: 'Description' })).toBeNull();
  });
});
