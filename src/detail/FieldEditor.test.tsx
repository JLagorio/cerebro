import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FieldEditor } from './FieldEditor';
import { fixtureVault, makeEntry } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import { useVaultStore } from '@/stores/vaultStore';
import * as relatedActions from '@/app/relatedActions';

beforeEach(() => useVaultStore.setState({ entries: fixtureVault() }));

it('hands a chosen draft value to onPatch without saving the record', () => {
  const entries = fixtureVault();
  const entry = entries.find((row) => row.type === 'Work item')!;
  const schema = buildSchema(entries);
  const def = schema.types.get('Work item')!.fields.find((field) => field.name === 'priority')!;
  const patch = vi.fn(async () => true);
  const onPatch = vi.fn();
  useVaultStore.setState({ patchFrontmatter: patch });
  render(<FieldEditor entry={entry} def={def} schema={schema} onPatch={onPatch} />);
  fireEvent.click(screen.getByRole('button', { name: 'High' }));
  fireEvent.click(screen.getByText('Low'));
  expect(onPatch).toHaveBeenCalledWith('low');
  expect(patch).not.toHaveBeenCalled();
});

it('stages scalar edits and clears without writing before Apply', () => {
  const entry = makeEntry({ path: 'record.md', properties: { estimate: 3 } });
  const patch = vi.fn(async () => true);
  const onPatch = vi.fn();
  useVaultStore.setState({ patchFrontmatter: patch });
  render(
    <FieldEditor
      entry={entry}
      def={{ name: 'estimate', kind: 'number' }}
      schema={buildSchema([entry])}
      onPatch={onPatch}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '3' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '8' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onPatch).toHaveBeenCalledWith(8);
  expect(patch).not.toHaveBeenCalled();
});

it('sends a derived relation edit through one reciprocal action without per-record writes', () => {
  const host = makeEntry({ path: 'records/project.md', title: 'Project', type: 'Project' });
  const child = makeEntry({ path: 'records/task.md', title: 'Task', type: 'Task' });
  const entries = [host, child];
  const schema = buildSchema(entries);
  const patch = vi.fn(async () => true);
  const write = vi.spyOn(relatedActions, 'writeReciprocal').mockResolvedValue(true);
  useVaultStore.setState({ entries, patchFrontmatter: patch });
  render(
    <FieldEditor
      entry={host}
      def={{ name: 'tasks', kind: 'relation', from: { type: 'Task', field: 'project' } }}
      schema={schema}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit Tasks' }));
  fireEvent.click(screen.getByTestId('relation-result-row'));
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(
    host,
    { type: 'Task', field: 'project' },
    ['task'],
    entries,
    schema,
  );
  expect(patch).not.toHaveBeenCalled();
  write.mockRestore();
});

it.each([
  { name: 'children', kind: 'relation' as const, from: { type: 'Task', field: 'project' } },
  { name: 'attachments', kind: 'files' as const },
])('a draft keeps $kind read-only until a record exists', (def) => {
  const entry = makeEntry({ path: '(draft)' });
  const patch = vi.fn();
  const onPatch = vi.fn();
  useVaultStore.setState({ patchFrontmatter: patch });
  const { container } = render(
    <FieldEditor entry={entry} def={def} schema={buildSchema([entry])} onPatch={onPatch} />,
  );
  expect(container.querySelector('button,input')).toBeNull();
  expect(screen.getByTitle('Available after this record is created')).toBeTruthy();
  expect(patch).not.toHaveBeenCalled();
  expect(onPatch).not.toHaveBeenCalled();
});
