// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { DocProperties } from '@/detail/DocProperties';
import { buildSchema } from '@/engine/schema';
import type { Entry } from '@/engine/types';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';

const DOC = 'inbox/welcome.md';

function setup(docPartial: Partial<Entry> = {}) {
  const entries = fixtureVault();
  const doc: Entry = {
    path: DOC,
    filename: 'welcome.md',
    folder: 'inbox',
    project: null,
    title: 'Welcome',
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T00:00:00Z',
    modifiedAt: '2026-07-02T00:00:00Z',
    parseError: null,
    ...docPartial,
  };
  const all = [...entries, doc];
  const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
  useVaultStore.setState({ entries: all, vaultPath: '/vault', patchFrontmatter });
  const schema = buildSchema(all);
  render(<DocProperties entry={doc} schema={schema} />);
  return { patchFrontmatter };
}

describe('DocProperties', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  // M12.1: docs are docs. The type is not a dropdown — the only way a doc
  // becomes a record is the explicit Convert action, which names the change.
  it('shows Type: Doc with no dropdown', () => {
    setup();
    expect(screen.getByText('Doc')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Type' })).toBeNull();
  });

  it('converts a doc to a record through the explicit Convert action', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(screen.getByRole('button', { name: 'Convert to record…' }));
    await user.click(screen.getByRole('option', { name: 'Work item' }));
    await user.click(screen.getByRole('button', { name: 'Convert to Work item' }));
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { type: 'Work item' });
  });

  // M15: conversion has no inverse in the app, so picking a type in the list
  // must select, not commit — a stray click used to convert immediately.
  it('selects a type without converting until the footer action is pressed', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(screen.getByRole('button', { name: 'Convert to record…' }));
    const row = screen.getByRole('option', { name: 'Work item' });
    expect(row.getAttribute('aria-selected')).toBe('false');
    await user.click(row);
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(screen.getByRole('option', { name: 'Work item' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('closes the convert dialog on Escape', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Convert to record…' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  // A text input round-tripped `tags: [work, urgent]` to disk as the single
  // string "work,urgent", silently destroying the YAML list.
  it('shows a list-valued loose key read-only instead of collapsing it', () => {
    setup({ properties: { tags: ['work', 'urgent'] } });
    expect(screen.queryByLabelText('Tags')).toBeNull();
    expect(screen.getByText('work, urgent')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove Tags' })).toBeTruthy();
  });

  // The remove affordance must exist in the tree (and so in the tab order)
  // rather than appearing only under a pointer.
  it('keeps the remove button mounted without hover', () => {
    setup({ properties: { source: 'imported' } });
    const remove = screen.getByRole('button', { name: 'Remove Source' });
    expect(remove.closest('span')?.className).toContain('opacity-0');
    expect(remove.closest('span')?.className).not.toContain('hidden');
  });

  // An untyped doc has no schema: every kind but the plain ones produced a
  // text box (a Checkbox opened as a text input containing "false").
  it('offers only plain kinds on an untyped doc', () => {
    setup();
    fireEvent.click(screen.getByText('+ Add property'));
    expect((screen.getByTestId('property-kind-text') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('property-kind-number') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('property-kind-checkbox') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('property-kind-date') as HTMLButtonElement).disabled).toBe(true);
  });

  it('never offers Convert on an already-typed entry', () => {
    setup({ type: 'Person', properties: { type: 'Person' } });
    expect(screen.getByText('Person')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Convert to record…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Type' })).toBeNull();
  });

  it('renders declared fields for a typed doc', () => {
    setup({ type: 'Work item', properties: { type: 'Work item', status: 'todo' } });
    // The Work item type declares status/priority in the fixture vault.
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Priority')).toBeTruthy();
  });

  it('edits an undeclared scalar on blur', () => {
    const { patchFrontmatter } = setup({ properties: { source: 'imported' } });
    const input = screen.getByLabelText('Source') as HTMLInputElement;
    expect(input.value).toBe('imported');
    fireEvent.change(input, { target: { value: 'manual' } });
    fireEvent.blur(input);
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { source: 'manual' });
  });

  it('keeps numeric undeclared values numeric', () => {
    const { patchFrontmatter } = setup({ properties: { effort: 3 } });
    const input = screen.getByLabelText('Effort') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { effort: 5 });
  });

  it('removes an undeclared property', () => {
    const { patchFrontmatter } = setup({ properties: { source: 'imported' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Source' }));
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { source: null });
  });

  it('adds a new empty property', () => {
    const { patchFrontmatter } = setup();
    fireEvent.click(screen.getByText('+ Add property'));
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'audience' } });
    fireEvent.keyDown(screen.getByLabelText('Property name'), { key: 'Enter' });
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { audience: '' });
  });

  // M16.9 moved this from a toast after the write was refused to a refusal
  // the surface states while you are still typing — and to the panel itself,
  // so RecordProperties gets the same guard instead of relying on
  // addPropertyToEntry, whose frontmatter-key check cannot see a declared
  // field the open record happens to leave empty.
  it('refuses a duplicate property name in place, before any write', () => {
    const { patchFrontmatter } = setup({ properties: { source: 'x' } });
    fireEvent.click(screen.getByText('+ Add property'));
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'source' } });

    expect(screen.getByRole('alert').textContent).toContain('already a property here');
    expect((screen.getByTestId('property-kind-text') as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(screen.getByLabelText('Property name'), { key: 'Enter' });
    expect(patchFrontmatter).not.toHaveBeenCalled();
  });
});
