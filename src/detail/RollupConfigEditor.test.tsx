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

it('offers Cached mail by capability and only its date and count calculations', () => {
  const person = makeEntry({
    path: 'types/person.md',
    type: 'Type',
    title: 'Contact',
    properties: { fields: { email: 'email' } },
  });
  const schema = buildSchema([person]);
  const change = vi.fn();
  const view = render(
    <RollupConfigEditor
      typeName="Contact"
      def={{ name: 'last', kind: 'rollup' }}
      schema={schema}
      onChange={change}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Relation to follow' }));
  fireEvent.click(screen.getByRole('option', { name: 'Cached mail' }));
  expect(change).toHaveBeenCalledWith({
    source: 'correspondence',
    relation: null,
    from: null,
    property: 'last_message_at',
    calculate: 'latest',
  });
  view.rerender(
    <RollupConfigEditor
      typeName="Contact"
      def={{ name: 'last', kind: 'rollup', source: 'correspondence', calculate: 'latest' }}
      schema={schema}
      onChange={change}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Calculation' }));
  expect(screen.getAllByRole('option')).toHaveLength(3);
  expect(screen.queryByRole('option', { name: 'Sum' })).toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'Property to aggregate' }));
  expect(screen.getByRole('option', { name: 'Last message at' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Display format' })).toBeNull();
});

it('lets an existing reverse rollup switch to Cached mail and clears the old source together', () => {
  const contact = makeEntry({
    path: 'types/contact.md',
    type: 'Type',
    title: 'Contact',
    properties: { fields: { email: 'email' } },
  });
  const change = vi.fn();
  render(
    <RollupConfigEditor
      typeName="Contact"
      def={{
        name: 'activity',
        kind: 'rollup',
        from: { type: 'Work item', field: 'owner' },
        property: 'effort',
        calculate: 'sum',
      }}
      schema={buildSchema([contact, workType])}
      onChange={change}
    />,
  );
  const source = screen.getByRole('button', { name: 'Relation to follow' });
  expect(source.textContent).toContain('Work item → Owner');
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(source);
  fireEvent.click(screen.getByRole('option', { name: 'Cached mail' }));
  expect(change).toHaveBeenCalledExactlyOnceWith({
    source: 'correspondence',
    relation: null,
    from: null,
    property: 'last_message_at',
    calculate: 'latest',
  });
});
