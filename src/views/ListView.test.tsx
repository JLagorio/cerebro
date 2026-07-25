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
    const labels = screen.getAllByTestId('group-header').map((h) => h.textContent ?? '');
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
      .getAllByTestId('group-header')
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
    });
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
      .getAllByTestId('group-header')
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
      .getAllByTestId('group-header')
      .find((h) => h.textContent?.includes('Todo'))!;
    const section = todoHeader.parentElement as HTMLElement;
    await user.click(within(section).getByText('Add item'));
    await user.type(within(section).getByRole('textbox'), 'never{Escape}');
    expect(within(section).queryByRole('textbox')).toBeNull();
    expect(createItem).not.toHaveBeenCalled();
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
