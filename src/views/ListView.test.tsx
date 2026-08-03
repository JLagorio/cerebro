import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListView } from '@/views/ListView';
import { FieldChip } from '@/views/FieldChip';
import { buildSchema } from '@/engine/schema';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { fixtureVault } from '@/test/factories';
import type { Presentation } from '@/engine/types';

const presentation: Presentation = {
  type: 'list',
  group: [{ field: 'status' }],
  sort: [{ field: 'modifiedAt', dir: 'desc' }],
  columns: [{ field: 'status' }, { field: 'priority' }, { field: 'assignee' }],
};

function setup(overrides: Partial<ReturnType<typeof useVaultStore.getState>> = {}) {
  const entries = fixtureVault();
  useVaultStore.setState({ entries, ...overrides });
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.path.startsWith('projects/onboarding/items/'));
  const project = entries.find((e) => e.path === 'projects/onboarding/project.md')!;
  render(
    <ListView entries={items} presentation={presentation} schema={schema} project={project} />,
  );
}

afterEach(cleanup);

describe('ListView', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
  });

  it('renders group headers in the schema status order, including empty groups', () => {
    setup();
    const labels = screen.getAllByTestId('list-group-header').map((h) => h.textContent ?? '');
    expect(labels[0]).toContain('Todo');
    expect(labels[1]).toContain('Doing');
    expect(labels[2]).toContain('Done'); // empty group still renders, proving schema order
  });

  it('renders a warning row for entries with a parse error', () => {
    setup();
    expect(screen.getByText('Cannot parse')).toBeTruthy();
    expect(screen.getByText('broken.md')).toBeTruthy();
  });

  it('quick-add creates an item with the group field value pre-set', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('items/ship-the-fix.md');
    setup({ createItem });
    const add = `New item in Doing`;
    await user.click(screen.getByRole('button', { name: add }));
    await user.type(screen.getByRole('textbox', { name: add }), 'Ship the fix{Enter}');
    // v2: containment membership — no `project:` wikilink in the frontmatter.
    expect(createItem).toHaveBeenCalledWith({
      folder: 'projects/onboarding/items',
      slug: 'ship-the-fix',
      frontmatter: {
        type: 'Work item',
        key: 'FLD-3',
        status: 'doing',
      },
      // The typed title becomes the H1 verbatim (M1.x capitalization fix).
      body: '# Ship the fix\n',
    });
  });

  // M1.x guard: double-Enter while the write is pending must not create two
  // items with identical keys (same guard as the CreateMenu dialogs).
  it('quick-add ignores a second Enter while the first create is pending', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn(() => new Promise<string>(() => {}));
    setup({ createItem });
    const add = `New item in Todo`;
    await user.click(screen.getByRole('button', { name: add }));
    await user.type(screen.getByRole('textbox', { name: add }), 'Once only{Enter}{Enter}');
    expect(createItem).toHaveBeenCalledTimes(1);
  });

  // M1.x fallback: slugify('???') === '' and create_note rejects empty slugs —
  // fall back to the generated key.
  it('quick-add falls back to the item key as slug for all-symbol titles', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('items/fld-3.md');
    setup({ createItem });
    const add = `New item in Todo`;
    await user.click(screen.getByRole('button', { name: add }));
    await user.type(screen.getByRole('textbox', { name: add }), '!!!{Enter}');
    expect(createItem.mock.calls[0][0].slug).toBe('fld-3');
    expect(createItem.mock.calls[0][0].body).toBe('# !!!\n');
  });

  // Deviation test (execution-log binding note 16a): createItem throws to
  // callers by design — the quick-add handler must surface the failure via a
  // toast instead of leaving an unhandled rejection, keeping the draft open.
  it('quick-add surfaces a createItem failure via toast and keeps the draft', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockRejectedValue(new Error('disk full'));
    useUiStore.setState({ toasts: [] });
    setup({ createItem });
    const add = `New item in Todo`;
    await user.click(screen.getByRole('button', { name: add }));
    await user.type(screen.getByRole('textbox', { name: add }), 'Doomed item{Enter}');
    await vi.waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        'Couldn\'t create "Doomed item"',
      );
    });
    expect(screen.getByRole('textbox', { name: add })).toBeTruthy();
  });

  it('quick-add cancels on Escape', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn();
    setup({ createItem });
    const add = `New item in Todo`;
    await user.click(screen.getByRole('button', { name: add }));
    await user.type(screen.getByRole('textbox', { name: add }), 'never{Escape}');
    expect(screen.queryByRole('textbox', { name: add })).toBeNull();
    expect(createItem).not.toHaveBeenCalled();
  });

  // Fix tests (execution-log note 17a): an empty project rendered a blank
  // canvas — groupEntries([], …) returns [] so there were no headers, no
  // Add-item row, and no empty state, leaving quick-add unreachable the
  // moment CreateMenu can create fresh projects.
  it('falls back to the flat all-items group when grouping yields no groups', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const project = entries.find((e) => e.path === 'projects/onboarding/project.md')!;
    render(<ListView entries={[]} presentation={presentation} schema={schema} project={project} />);
    const headers = screen.getAllByTestId('list-group-header');
    expect(headers).toHaveLength(1);
    expect(headers[0].textContent).toContain('All items');
    expect(screen.getByText('Add item')).toBeTruthy();
  });

  it('quick-add via the empty-project fallback group does not preset the group field', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('items/first-item.md');
    const entries = fixtureVault();
    useVaultStore.setState({ entries, createItem });
    const schema = buildSchema(entries);
    const project = entries.find((e) => e.path === 'projects/onboarding/project.md')!;
    render(<ListView entries={[]} presentation={presentation} schema={schema} project={project} />);
    await user.click(screen.getByText('Add item'));
    await user.type(screen.getByRole('textbox'), 'First item{Enter}');
    // No `status: ''` leak from the fallback group's empty key.
    expect(createItem).toHaveBeenCalledWith({
      folder: 'projects/onboarding/items',
      slug: 'first-item',
      frontmatter: { type: 'Work item', key: 'FLD-3' },
      body: '# First item\n',
    });
  });
});

/**
 * Keyboard access and the empty state (M15).
 *
 * ListRow was a `<div role="row">` with an onClick, no tabIndex and no roving
 * container — the hook was imported by TableView alone, so this layout had no
 * keyboard path to a record at all. A zero-row view also rendered nothing but
 * the grey "All items 0" strip, which reads as a load failure.
 */
describe('ListView keyboard and empty state (M15)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ detailPath: null });
  });

  it('lands a visible cursor on the first row when the list takes focus', () => {
    setup();
    const list = screen.getByTestId('list-view');
    expect(list.getAttribute('role')).toBe('grid');
    fireEvent.focus(list, { target: list });
    const rows = screen.getAllByTestId('list-row');
    expect(rows[0].getAttribute('aria-selected')).toBe('true');
    expect(list.getAttribute('aria-activedescendant')).toBe(rows[0].id);
  });

  it('opens a record with Enter after arrowing to it', () => {
    setup();
    const list = screen.getByTestId('list-view');
    fireEvent.focus(list, { target: list });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(useUiStore.getState().detailPath).not.toBeNull();
  });

  it('creates from the canvas when only onCreate is passed — no project needed', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(true);
    const entries = fixtureVault();
    useVaultStore.setState({ entries });
    const schema = buildSchema(entries);
    const items = entries.filter((e) => e.path.startsWith('projects/onboarding/items/'));
    render(
      <ListView
        entries={items}
        presentation={presentation}
        schema={schema}
        project={null}
        onCreate={onCreate}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'New item in Doing' }));
    await user.type(screen.getByRole('textbox', { name: 'New item in Doing' }), 'Ship it{Enter}');
    expect(onCreate).toHaveBeenCalledWith('Ship it', { groupBy: 'status', groupValue: 'doing' });
  });

  it('says why a filtered view is empty instead of showing a bare count strip', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    render(
      <ListView entries={[]} presentation={presentation} schema={schema} project={null} filtered />,
    );
    expect(screen.getByText('Nothing matches these filters')).toBeTruthy();
  });
});

/**
 * Row affordances (M16.21).
 *
 * A list row was a `<div role="row">` with an onClick: clickable with a mouse,
 * openable with the grid's Enter key, and carrying no NAMED control anywhere —
 * so assistive tech saw a strip of text with no announced way to act on it.
 * And opening was the only thing a list could do to a record: copying a link,
 * duplicating, deleting all meant opening it first to reach the panel header.
 */
describe('ListView row affordances (M16.21)', () => {
  beforeEach(() => {
    useVaultStore.setState({ entries: fixtureVault() });
    useUiStore.setState({ detailPath: null });
  });

  it('gives every row a named Open control', () => {
    setup();
    const open = screen.getAllByTestId('row-open-affordance');
    expect(open.length).toBeGreaterThan(0);
    expect(open[0].getAttribute('aria-label')).toBe('Open Design first-run flow');
  });

  it('opens the record from that control', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Open Design first-run flow' }));
    expect(useUiStore.getState().detailPath).toBe('projects/onboarding/items/fld-1.md');
  });

  it('offers the record actions the panel header has, without opening the record', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Design first-run flow' }));
    expect(screen.getByTestId('row-copy-link')).toBeTruthy();
    expect(screen.getByTestId('row-duplicate')).toBeTruthy();
    expect(screen.getByTestId('row-delete')).toBeTruthy();
    // Opening the menu is not opening the row — the click must not fall
    // through to the row's own handler.
    expect(useUiStore.getState().detailPath).toBeNull();
  });

  it('confirms before deleting, naming what links to the record', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: 'Actions for Design first-run flow' }));
    await user.click(screen.getByTestId('row-delete'));
    expect(screen.getByText('Delete "Design first-run flow"?')).toBeTruthy();
  });
});

describe('FieldChip', () => {
  afterEach(cleanup);

  it('renders ghost values with dashed muted styling', () => {
    const { container } = render(
      <FieldChip
        resolved={{ def: null, raw: 'weird', display: 'weird', color: null, ghost: true }}
      />,
    );
    expect((container.firstChild as HTMLElement).className).toContain('border-dashed');
  });

  it('renders nothing for empty values', () => {
    const { container } = render(
      <FieldChip resolved={{ def: null, raw: null, display: '', color: null, ghost: false }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
