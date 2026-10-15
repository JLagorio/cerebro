import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RelationConfigEditor } from './RelationConfigEditor';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';
import type { FieldDef } from '@/engine/types';

afterEach(cleanup);
const schema = buildSchema([
  makeEntry({ path: 'types/task.md', title: 'Task', type: 'Type' }),
  makeEntry({ path: 'types/skill.md', title: 'Skill', type: 'Type' }),
  makeEntry({ path: 'types/person.md', title: 'Person', type: 'Type' }),
]);
function setup(kind: 'relation' | 'person', target?: string) {
  const onChange = vi.fn();
  const onAddReciprocal = vi.fn();
  const def: FieldDef = { name: 'owner', kind, ...(target === undefined ? {} : { target }) };
  render(
    <RelationConfigEditor
      typeName="Task"
      def={def}
      schema={schema}
      onChange={onChange}
      onAddReciprocal={onAddReciprocal}
    />,
  );
  return { onChange, onAddReciprocal };
}

describe('explicit Agent relation config', () => {
  it('lets a relation target Agent even though it has no Type doc', () => {
    const { onChange } = setup('relation');
    fireEvent.click(screen.getByRole('button', { name: 'Related to' }));
    fireEvent.click(screen.getByRole('option', { name: 'Agent' }));
    expect(onChange).toHaveBeenCalledWith({ target: 'Agent' });
  });

  it('does not list a library target for a person field', () => {
    setup('person');
    fireEvent.click(screen.getByRole('button', { name: 'People come from' }));
    expect(screen.queryByRole('option', { name: 'Agent' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Skill' })).toBeNull();
    expect(screen.getByRole('option', { name: 'Person' })).toBeTruthy();
  });

  it('never adds a reciprocal on a library target', () => {
    const { onAddReciprocal } = setup('relation', 'Agent');
    expect(screen.getByTestId('relation-no-reciprocal').textContent).toContain(
      'Agents keep no list of their own.',
    );
    expect(screen.queryByTestId('add-reciprocal')).toBeNull();
    expect(screen.queryByLabelText('Related property name')).toBeNull();
    expect(onAddReciprocal).not.toHaveBeenCalled();
  });
});
