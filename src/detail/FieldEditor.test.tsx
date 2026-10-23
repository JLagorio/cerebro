import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

it('stages scalar edits and clears without writing before Apply', async () => {
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
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
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

it('shows a PR chip in page fields while table and caller-owned drafts keep plain links', () => {
  const entry = makeEntry({
    path: 'pr.md',
    properties: { url: 'https://github.com/acme/notes/pull/1' },
  });
  const props = { entry, def: { name: 'url', kind: 'url' as const }, schema: buildSchema([entry]) };
  const { rerender } = render(<FieldEditor {...props} chrome="panel" />);
  expect(screen.getByTestId('pr-chip')).toBeTruthy();
  rerender(<FieldEditor {...props} chrome="cell" />);
  expect(screen.queryByTestId('pr-chip')).toBeNull();
  expect(screen.getByRole('link').textContent).toBe(entry.properties.url);
  rerender(<FieldEditor {...props} chrome="panel" onPatch={() => {}} />);
  expect(screen.queryByTestId('pr-chip')).toBeNull();
});

it('shares Enter and blur with one pending write and keeps a refused draft for one retry', async () => {
  const entry = makeEntry({ path: 'draft.md', properties: { summary: 'Before' } });
  const editing = vi.fn();
  let resolveWrite!: (saved: boolean) => void;
  const patch = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        resolveWrite = resolve;
      }),
  );
  useVaultStore.setState({ patchFrontmatter: patch });
  render(
    <FieldEditor
      entry={entry}
      def={{ name: 'summary', kind: 'text' }}
      schema={buildSchema([entry])}
      onEditingChange={editing}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  const input = screen.getByRole('textbox', { name: 'Summary' });
  fireEvent.change(input, { target: { value: '  Keep this draft  ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.blur(input);
  expect(patch).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status').textContent).toBe('Saving…');
  expect(editing).toHaveBeenLastCalledWith(true);
  await act(async () => resolveWrite(false));
  expect((input as HTMLInputElement).value).toBe('  Keep this draft  ');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(editing).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('status').textContent).toContain('Your draft is kept');
  fireEvent.blur(input);
  expect(patch).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(patch).toHaveBeenCalledTimes(2);
  expect(patch).toHaveBeenLastCalledWith('draft.md', { summary: 'Keep this draft' });
  await act(async () => resolveWrite(true));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(editing).toHaveBeenLastCalledWith(false);
});

it('cancels a scalar draft without a blur write and respects composition', () => {
  const entry = makeEntry({ path: 'draft.md', properties: { summary: 'Before' } });
  const patch = vi.fn(async () => true);
  useVaultStore.setState({ patchFrontmatter: patch });
  render(
    <FieldEditor
      entry={entry}
      def={{ name: 'summary', kind: 'text' }}
      schema={buildSchema([entry])}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Composing' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(patch).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Escape' });
  fireEvent.blur(input);
  expect(patch).not.toHaveBeenCalled();
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('retains invalid numeric input with a nearby correction reason', () => {
  const entry = makeEntry({ path: 'draft.md', properties: { estimate: 3 } });
  const patch = vi.fn(async () => true);
  useVaultStore.setState({ patchFrontmatter: patch });
  render(
    <FieldEditor
      entry={entry}
      def={{ name: 'estimate', kind: 'number' }}
      schema={buildSchema([entry])}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '3' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'Infinity' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(patch).not.toHaveBeenCalled();
  expect((input as HTMLInputElement).value).toBe('Infinity');
  expect(screen.getByRole('status').textContent).toBe('Enter a finite number.');
});

it('does not carry an open scalar draft onto a different record', () => {
  const first = makeEntry({ path: 'first.md', properties: { summary: 'First' } });
  const second = makeEntry({ path: 'second.md', properties: { summary: 'Second' } });
  const schema = buildSchema([first, second]);
  const def = { name: 'summary', kind: 'text' as const };
  const { rerender } = render(<FieldEditor entry={first} def={def} schema={schema} />);
  fireEvent.click(screen.getByRole('button', { name: 'First' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsubmitted' } });
  rerender(<FieldEditor entry={second} def={def} schema={schema} />);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('button', { name: 'Second' })).toBeTruthy();
});

// 2026-10-18: a `generated: {by, at}` stamp under a key its type declared as
// text drew "[object Object]", and a click then a blur wrote that text back
// over the map. A map under a text key is shown, never put in a field.
it('shows a map under a text key as its lines, and never offers a field to write it', () => {
  const stamp = { by: 'claude-code', at: 'soon' };
  const entry = makeEntry({ path: 'stamped.md', properties: { generated: stamp as never } });
  const patch = vi.fn(async () => true);
  useVaultStore.setState({ patchFrontmatter: patch });
  const { container } = render(
    <FieldEditor
      entry={entry}
      def={{ name: 'generated', kind: 'text' }}
      schema={buildSchema([entry])}
      chrome="panel"
    />,
  );
  expect(container.textContent).not.toContain('[object Object]');
  const lines = screen.getByTestId('structured-value');
  expect([...lines.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['by', 'at']);
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.click(lines);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(patch).not.toHaveBeenCalled();
});

it('reads a map in a table cell as one line of keys and values', () => {
  const entry = makeEntry({
    path: 'stamped.md',
    properties: { generated: { by: 'claude-code', at: 'soon' } as never },
  });
  const { container } = render(
    <FieldEditor
      entry={entry}
      def={{ name: 'generated', kind: 'text' }}
      schema={buildSchema([entry])}
      chrome="cell"
    />,
  );
  expect(container.textContent).toBe('by claude-code · at soon');
});
