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
    useUiStore.setState({ toasts: [], docPropsCollapsed: false });
  });
  afterEach(cleanup);

  it('assigns a type through the dropdown', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup();
    await user.click(screen.getByRole('button', { name: 'Type' }));
    await user.click(screen.getByRole('option', { name: 'Work item' }));
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { type: 'Work item' });
  });

  it('clearing the type writes null', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup({ type: 'Person', properties: { type: 'Person' } });
    await user.click(screen.getByRole('button', { name: 'Type' }));
    await user.click(screen.getByRole('option', { name: 'None' }));
    expect(patchFrontmatter).toHaveBeenCalledWith(DOC, { type: null });
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

  it('refuses a duplicate property name with a toast', () => {
    const { patchFrontmatter } = setup({ properties: { source: 'x' } });
    fireEvent.click(screen.getByText('+ Add property'));
    fireEvent.change(screen.getByLabelText('Property name'), { target: { value: 'source' } });
    fireEvent.keyDown(screen.getByLabelText('Property name'), { key: 'Enter' });
    expect(patchFrontmatter).not.toHaveBeenCalled();
    expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
      'Property already exists',
    );
  });

  it('the header collapse control persists the panel state', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Hide properties' }));
    expect(useUiStore.getState().docPropsCollapsed).toBe(true);
    expect(window.localStorage.getItem('cerebro.docPropsCollapsed')).toBe('true');
  });
});
