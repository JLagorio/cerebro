import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FieldEditor } from './FieldEditor';
import { fixtureVault, makeEntry } from '@/test/factories';
import { buildSchema } from '@/engine/schema';
import { useVaultStore } from '@/stores/vaultStore';
import { requestLeave } from '@/app/leaveGuard';
import { __resetOpenPages, flushOpenPages, unresolvedOpenPages } from '@/editor/openPages';
import * as relatedActions from '@/app/relatedActions';

beforeEach(() => {
  __resetOpenPages();
  useVaultStore.setState({
    entries: fixtureVault(),
    vaultPath: '/field-vault',
    entriesVault: '/field-vault',
    status: 'ready',
  });
});

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

it.each(['person', 'relation'] as const)(
  'updates an open %s picker from live entries without losing its query',
  (kind) => {
    const entry = makeEntry({ path: 'tasks/owner.md', type: 'Task' });
    const ana = makeEntry({ path: 'people/ana-rios.md', title: 'Ana Rios', type: 'Person' });
    const bo = makeEntry({ path: 'people/bo-chen.md', title: 'Bo Chen', type: 'Person' });
    const entries = [entry, ana];
    const patch = vi.fn(async () => true);
    useVaultStore.setState({ entries, patchFrontmatter: patch });
    render(
      <FieldEditor
        entry={entry}
        def={{ name: 'owner', kind, target: 'Person', limit: 1 }}
        schema={buildSchema(entries)}
        placeholder="blank"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: kind === 'person' ? 'Owner' : 'Edit Owner' }),
    );
    const search = screen.getByRole('textbox');
    fireEvent.change(search, { target: { value: 'Bo' } });
    expect(screen.queryByText('Bo Chen')).toBeNull();

    act(() => useVaultStore.setState({ entries: [entry, bo] }));

    expect(screen.getByRole('textbox')).toBe(search);
    expect(search).toHaveProperty('value', 'Bo');
    expect(document.activeElement).toBe(search);
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole(kind === 'person' ? 'option' : 'button', { name: /Bo Chen/ }));
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith('tasks/owner.md', { owner: ['[[bo-chen]]'] });
    expect(screen.queryByRole('textbox')).toBeNull();
  },
);

it('keeps a focused scalar draft when the store or write action changes', async () => {
  const entry = makeEntry({ path: 'live-action.md', properties: { summary: 'Before' } });
  const originalPatch = vi.fn(async () => true);
  const currentPatch = vi.fn(async () => true);
  useVaultStore.setState({ patchFrontmatter: originalPatch });
  render(
    <FieldEditor
      entry={entry}
      def={{ name: 'summary', kind: 'text' }}
      schema={buildSchema([entry])}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  const input = screen.getByRole('textbox', { name: 'Summary' });
  fireEvent.change(input, { target: { value: '  Keep exact draft  ' } });

  act(() => useVaultStore.setState({ status: 'scanning' }));
  expect(screen.getByRole('textbox', { name: 'Summary' })).toBe(input);
  expect(input).toHaveProperty('value', '  Keep exact draft  ');
  expect(document.activeElement).toBe(input);
  act(() => useVaultStore.setState({ patchFrontmatter: currentPatch }));
  expect(screen.getByRole('textbox', { name: 'Summary' })).toBe(input);
  expect(input).toHaveProperty('value', '  Keep exact draft  ');
  expect(document.activeElement).toBe(input);
  expect(originalPatch).not.toHaveBeenCalled();
  expect(currentPatch).not.toHaveBeenCalled();

  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(originalPatch).not.toHaveBeenCalled();
  expect(currentPatch).toHaveBeenCalledTimes(1);
  expect(currentPatch).toHaveBeenCalledWith('live-action.md', { summary: 'Keep exact draft' });
});

it('does not carry a local draft across vaults with the same path and property', () => {
  const entry = makeEntry({ path: 'same-path.md', properties: { summary: 'Before' } });
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
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First vault draft' } });

  act(() =>
    useVaultStore.setState({ vaultPath: '/other-field-vault', entriesVault: '/other-field-vault' }),
  );

  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'Before');
  expect(patch).not.toHaveBeenCalled();
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

it('Save captures a focused scalar before blur and reports the actual guarded patch result', async () => {
  const entry = makeEntry({ path: 'focused.md', properties: { summary: 'Before' } });
  const patch = vi.fn().mockResolvedValue(true);
  useVaultStore.setState({ patchFrontmatter: patch });
  render(
    <FieldEditor
      entry={entry}
      def={{ name: 'summary', kind: 'text' }}
      schema={buildSchema([entry])}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Focused exact  ' } });
  expect(unresolvedOpenPages()[0].latestDraft).toBe('  Focused exact  ');
  let report!: Awaited<ReturnType<typeof flushOpenPages>>;
  await act(async () => {
    report = await flushOpenPages();
  });
  expect(patch).toHaveBeenCalledWith('focused.md', { summary: 'Focused exact' });
  expect(report.outcomes[0]).toMatchObject({ kind: 'committed', source: 'guarded_field' });
  expect(report.unresolvedOwnerIds).toEqual([]);
});
it('reopens a failed durable scalar with exact input and accessible Retry without another edit', async () => {
  const entry = makeEntry({ path: 'retained.md', properties: { summary: 'Before' } });
  const patch = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  useVaultStore.setState({ patchFrontmatter: patch });
  const props = {
    entry,
    def: { name: 'summary', kind: 'text' as const },
    schema: buildSchema([entry]),
  };
  const first = render(<FieldEditor {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Refused exact  ' } });
  await act(async () => {
    await flushOpenPages();
  });
  first.unmount();
  expect(unresolvedOpenPages()[0].latestDraft).toBe('  Refused exact  ');
  render(<FieldEditor {...props} />);
  expect(screen.getByRole('textbox')).toHaveProperty('value', '  Refused exact  ');
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving Summary' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(patch).toHaveBeenCalledTimes(2);
});
it('never registers caller-owned creation scalar edits as durable fields', async () => {
  const entry = makeEntry({ path: '(draft)', properties: { estimate: 3 } });
  render(
    <FieldEditor
      entry={entry}
      def={{ name: 'estimate', kind: 'number' }}
      schema={buildSchema([entry])}
      onPatch={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '3' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Infinity' } });
  expect(unresolvedOpenPages()).toEqual([]);
  expect((await flushOpenPages()).outcomes).toEqual([]);
});
it('a leave action captures the focused scalar and stays mounted on a preexisting failure', async () => {
  const entry = makeEntry({ path: 'leave.md', properties: { summary: 'Before' } });
  const patch = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  useVaultStore.setState({ patchFrontmatter: patch });
  render(
    <FieldEditor
      entry={entry}
      def={{ name: 'summary', kind: 'text' }}
      schema={buildSchema([entry])}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Before' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Before blur  ' } });
  const leave = vi.fn();
  await act(async () => {
    expect(requestLeave('field-leave', leave)).toBe(false);
  });
  expect(leave).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveProperty('value', '  Before blur  ');
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving Summary' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(requestLeave('field-leave', leave)).toBe(true);
  expect(leave).toHaveBeenCalledTimes(1);
});
