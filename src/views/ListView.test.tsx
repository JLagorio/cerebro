import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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
  groupBy: 'status',
  orderBy: { field: 'modifiedAt', dir: 'desc' },
  visibleFields: ['status', 'priority', 'assignee'],
};

function setup(overrides: Partial<ReturnType<typeof useVaultStore.getState>> = {}) {
  const entries = fixtureVault();
  useVaultStore.setState({ entries, ...overrides });
  const schema = buildSchema(entries);
  const items = entries.filter((e) => e.path.startsWith('items/'));
  const project = entries.find((e) => e.path === 'projects/onboarding.md')!;
  render(<ListView entries={items} presentation={presentation} schema={schema} project={project} />);
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
    const doingHeader = screen
      .getAllByTestId('list-group-header')
      .find((h) => h.textContent?.includes('Doing'))!;
    const section = doingHeader.parentElement as HTMLElement;
    await user.click(within(section).getByText('Add item'));
    await user.type(within(section).getByRole('textbox'), 'Ship the fix{Enter}');
    expect(createItem).toHaveBeenCalledWith({
      folder: 'items',
      slug: 'ship-the-fix',
      frontmatter: {
        type: 'Work item',
        key: 'FLD-3',
        project: '[[onboarding]]',
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
    const todoHeader = screen
      .getAllByTestId('list-group-header')
      .find((h) => h.textContent?.includes('Todo'))!;
    const section = todoHeader.parentElement as HTMLElement;
    await user.click(within(section).getByText('Add item'));
    await user.type(within(section).getByRole('textbox'), 'Once only{Enter}{Enter}');
    expect(createItem).toHaveBeenCalledTimes(1);
  });

  // M1.x fallback: slugify('???') === '' and create_note rejects empty slugs —
  // fall back to the generated key.
  it('quick-add falls back to the item key as slug for all-symbol titles', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('items/fld-3.md');
    setup({ createItem });
    const todoHeader = screen
      .getAllByTestId('list-group-header')
      .find((h) => h.textContent?.includes('Todo'))!;
    const section = todoHeader.parentElement as HTMLElement;
    await user.click(within(section).getByText('Add item'));
    await user.type(within(section).getByRole('textbox'), '!!!{Enter}');
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
    const todoHeader = screen
      .getAllByTestId('list-group-header')
      .find((h) => h.textContent?.includes('Todo'))!;
    const section = todoHeader.parentElement as HTMLElement;
    await user.click(within(section).getByText('Add item'));
    await user.type(within(section).getByRole('textbox'), 'Doomed item{Enter}');
    await vi.waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.message)).toContain(
        'Couldn\'t create "Doomed item"',
      );
    });
    expect(within(section).getByRole('textbox')).toBeTruthy();
  });

  it('quick-add cancels on Escape', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn();
    setup({ createItem });
    const todoHeader = screen
      .getAllByTestId('list-group-header')
      .find((h) => h.textContent?.includes('Todo'))!;
    const section = todoHeader.parentElement as HTMLElement;
    await user.click(within(section).getByText('Add item'));
    await user.type(within(section).getByRole('textbox'), 'never{Escape}');
    expect(within(section).queryByRole('textbox')).toBeNull();
    expect(createItem).not.toHaveBeenCalled();
  });

  // Fix tests (execution-log note 17a): an empty project rendered a blank
  // canvas — groupEntries([], …) returns [] so there were no headers, no
  // Add-item row, and no empty state, leaving quick-add unreachable the
  // moment CreateMenu can create fresh projects.
  it('falls back to the flat all-items group when grouping yields no groups', () => {
    const entries = fixtureVault();
    const schema = buildSchema(entries);
    const project = entries.find((e) => e.path === 'projects/onboarding.md')!;
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
    const project = entries.find((e) => e.path === 'projects/onboarding.md')!;
    render(<ListView entries={[]} presentation={presentation} schema={schema} project={project} />);
    await user.click(screen.getByText('Add item'));
    await user.type(screen.getByRole('textbox'), 'First item{Enter}');
    // No `status: ''` leak from the fallback group's empty key.
    expect(createItem).toHaveBeenCalledWith({
      folder: 'items',
      slug: 'first-item',
      frontmatter: { type: 'Work item', key: 'FLD-3', project: '[[onboarding]]' },
      body: '# First item\n',
    });
  });
});

describe('FieldChip', () => {
  afterEach(cleanup);

  it('renders ghost values with dashed muted styling', () => {
    const { container } = render(
      <FieldChip resolved={{ def: null, raw: 'weird', display: 'weird', color: null, ghost: true }} />,
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
