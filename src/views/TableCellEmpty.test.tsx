// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecordProperties } from '@/detail/RecordProperties';
import { TableView } from '@/views/TableView';
import { buildSchema } from '@/engine/schema';
import { fixtureVault, makeEntry } from '@/test/factories';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import type { Entry, Presentation } from '@/engine/types';

/**
 * An unset TABLE cell is blank; an unset PANEL property is not (M16.35).
 *
 * Measured against Notion side by side: its table paints an unset cell with
 * nothing at all — no ghost text, no chevron, no per-cell type icon, the
 * affordance arrives on hover — while its record page keeps the grey "Empty"
 * standing in for the value. Cerebro shared one `FieldEditor` between the two
 * surfaces and so painted "Empty" plus a glyph in both, which is why a single
 * viewport of table cells carried 450 icons.
 *
 * These two describes are a pair: neither is allowed to drift onto the other's
 * behaviour.
 */

const EMPTY_RECORD = 'projects/onboarding/items/fld-3.md';

const presentation: Presentation = {
  type: 'table',
  group: [],
  sort: [],
  columns: [
    { field: 'status' },
    { field: 'priority' },
    { field: 'assignee' },
    { field: 'due' },
    { field: 'summary' },
  ],
};

/** The fixture vault plus a text field on the type and a record that sets
 * none of the five columns. */
function vaultWithEmptyRecord(): { entries: Entry[]; record: Entry } {
  const entries = fixtureVault();
  const typeDoc = entries.find((e) => e.path === 'types/work-item.md')!;
  (typeDoc.properties as unknown as { fields: Record<string, unknown> }).fields.summary = {
    kind: 'text',
  };
  const record = makeEntry({
    path: EMPTY_RECORD,
    project: 'projects/onboarding/project.md',
    title: 'Nothing filled in',
    type: 'Work item',
    properties: { key: 'FLD-3' },
  });
  entries.push(record);
  return { entries, record };
}

function renderTable() {
  const { entries, record } = vaultWithEmptyRecord();
  useVaultStore.setState({ entries, patchFrontmatter: vi.fn().mockResolvedValue(undefined) });
  const schema = buildSchema(entries);
  const filled = entries.find((e) => e.path === 'projects/onboarding/items/fld-1.md')!;
  render(
    <TableView
      entries={[record, filled]}
      presentation={presentation}
      schema={schema}
      fields={schema.types.get('Work item')?.fields ?? []}
    />,
  );
  return { record, filled, schema };
}

/** Scope to one row: the column HEADER buttons carry the property name too. */
const row = (title: string): HTMLElement =>
  screen.getByRole('button', { name: `Open ${title}` }).closest('[data-testid="table-row"]')!;

/** The five blank cells name themselves after their property — a control that
 * draws nothing has no other accessible name. */
const cell = (name: string) => within(row('Nothing filled in')).getByRole('button', { name });

afterEach(cleanup);

describe('an unset table cell is blank (M16.35)', () => {
  beforeEach(() => {
    useUiStore.setState({ detailPath: null });
    useNavStore.setState({
      selection: { kind: 'list', id: 'at-risk-work' },
      history: [{ kind: 'list', id: 'at-risk-work' }],
      historyIndex: 0,
    });
  });

  it('paints no ghost text and no glyph', () => {
    renderTable();

    for (const name of ['Status', 'Priority', 'Assignee', 'Due', 'Summary']) {
      const control = cell(name);
      // No "Empty", no chevron, no calendar — the cell is empty in the
      // literal sense.
      expect(control.textContent).toBe('');
      expect(control.querySelector('svg')).toBeNull();
    }
    // Not one anywhere in the grid, including the row that IS filled in.
    expect(screen.queryByText('Empty')).toBeNull();
  });

  it('leaves a value that IS set alone — chevron included', () => {
    const { filled } = renderTable();

    // The blast radius check: `placeholder` governs the UNSET state only.
    const status = within(row(filled.title))
      .getByText(/^todo$/i)
      .closest('button')!;
    expect(status.querySelector('svg')).not.toBeNull();
  });

  it('keeps the blank cell a full-size hit target, not a collapsed one', () => {
    renderTable();

    const control = cell('Summary');
    // Blank means "draws no glyph", never "renders nothing interactive": the
    // button is still in the DOM and still takes focus.
    expect(control.tagName).toBe('BUTTON');
    control.focus();
    expect(document.activeElement).toBe(control);
    // jsdom has no layout, so the guarantee is asserted on the classes that
    // provide it: a button with no children is 16px of padding unless it is
    // told to fill the cell it sits in.
    expect(control.className).toContain('flex-1');
    expect(control.className).toContain('self-stretch');
    expect(control.className).toContain('min-h-[22px]');
  });

  it('opens the editor when a blank cell is clicked', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(cell('Summary'));
    const input = within(row('Nothing filled in')).getByRole('textbox');
    expect(input).toBe(document.activeElement);
  });

  it('opens the option picker from a blank status cell', async () => {
    const user = userEvent.setup();
    renderTable();

    await user.click(cell('Status'));
    expect(screen.getByRole('listbox')).toBeTruthy();
  });
});

describe('the record panel keeps its "Empty" ghost (M16.35)', () => {
  it('still renders Empty for the very same unset values', () => {
    const { entries, record } = vaultWithEmptyRecord();
    useVaultStore.setState({ entries, patchFrontmatter: vi.fn().mockResolvedValue(undefined) });
    const schema = buildSchema(entries);

    const { container } = render(<RecordProperties entry={record} schema={schema} />);

    // status, priority, assignee, due, summary — all five declared fields are
    // unset, and Notion's record page shows every one of them as "Empty".
    expect(within(container).getAllByText('Empty')).toHaveLength(5);
  });
});
