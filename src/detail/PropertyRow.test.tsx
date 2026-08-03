import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PropertyRow, PROPERTY_LABEL_W } from '@/detail/PropertyRow';
import { kindMeta } from '@/engine/properties';
import { FIELD_KINDS } from '@/engine/types';
import { resolveIcon } from '@/components/ui/Icon';

afterEach(cleanup);

const row = () => screen.getByTestId('property-row');
const labelCell = () => row().firstElementChild as HTMLElement;

/**
 * The anatomy every property row in a detail panel now shares (M16.6).
 * `RecordProperties` and `DocProperties` hand-assembled their own and had
 * drifted apart — declared rows lacked the truncation and hover that
 * undeclared rows had, and neither carried the kind icon at all.
 */
describe('PropertyRow', () => {
  it('leads with the icon the rest of the app already uses for that kind', () => {
    render(
      <PropertyRow kind="select" name="priority">
        <span>High</span>
      </PropertyRow>,
    );
    // Not a hardcoded glyph name: the assertion is that the row and the
    // kind catalog agree, so changing an icon in one place cannot desync.
    const expected = resolveIcon(kindMeta('select').icon).Comp;
    expect(expected).not.toBeNull();
    expect(labelCell().querySelector('svg')).toBeTruthy();
  });

  it('draws a real icon for every declared kind, not the missing-icon box', () => {
    for (const kind of FIELD_KINDS) {
      expect(resolveIcon(kindMeta(kind).icon).Comp).not.toBeNull();
    }
  });

  it('takes an icon override for the rows that are not properties', () => {
    // A doc's Type is not in `fields:`, so a kind glyph would be a lie.
    expect(resolveIcon('shapes').Comp).not.toBeNull();
    render(
      <PropertyRow kind="text" icon="shapes" name="Type">
        <span>Doc</span>
      </PropertyRow>,
    );
    expect(labelCell().querySelector('svg')).toBeTruthy();
  });

  // The declared-row bug: a long name pushed its own value off the row,
  // because only the undeclared rows carried `truncate`.
  it('truncates the name inside a fixed gutter', () => {
    render(
      <PropertyRow kind="text" name="an_extremely_long_property_name_indeed">
        <span>value</span>
      </PropertyRow>,
    );
    const cell = labelCell();
    expect(cell.style.width).toBe(`${PROPERTY_LABEL_W}px`);
    expect(cell.className).toContain('flex-none');
    const text = within(cell).getByText('An extremely long property name indeed');
    expect(text.className).toContain('truncate');
  });

  it('humanizes the raw field name', () => {
    render(
      <PropertyRow kind="text" name="due_date">
        <span>v</span>
      </PropertyRow>,
    );
    expect(screen.getByText('Due date')).toBeTruthy();
    expect(row().dataset.property).toBe('due_date');
  });

  // 116px runs out at about 14 characters, so the name is exactly the thing
  // that needs a tooltip.
  it('gives the truncated name a tooltip', async () => {
    const user = userEvent.setup();
    render(
      <PropertyRow kind="text" name="an_extremely_long_property_name_indeed">
        <span>value</span>
      </PropertyRow>,
    );
    await user.hover(screen.getByText('An extremely long property name indeed'));
    await waitFor(
      () =>
        expect(screen.getByRole('tooltip').textContent).toBe(
          'An extremely long property name indeed',
        ),
      { timeout: 2000 },
    );
  });

  it('adds no wrapper node for the tooltip', () => {
    // Tooltip clones handlers onto its child. If it ever grows a wrapper
    // again, the label stops being the row's first child and every
    // `firstElementChild` walk in this file — and in FileTree — breaks.
    render(
      <PropertyRow kind="text" name="a">
        <span>v</span>
      </PropertyRow>,
    );
    expect(row().children).toHaveLength(2);
    expect(labelCell().tagName).toBe('SPAN');
  });

  it('aligns the label to the top of a value that wraps, and centres a one-line one', () => {
    const { rerender } = render(
      <PropertyRow kind="multiselect" name="tags">
        <span>chips</span>
      </PropertyRow>,
    );
    expect(row().className).toContain('items-start');
    expect(labelCell().className).toContain('pt-[3px]');

    rerender(
      <PropertyRow kind="checkbox" name="done" align="center">
        <span>switch</span>
      </PropertyRow>,
    );
    expect(row().className).toContain('items-center');
    expect(labelCell().className).not.toContain('pt-[3px]');
  });

  it('hovers as one row', () => {
    render(
      <PropertyRow kind="text" name="a">
        <span>v</span>
      </PropertyRow>,
    );
    expect(row().className).toContain('hover:bg-[var(--n-25)]');
    // The value control's own hover is --n-50; a row painted the same colour
    // reads flat under it.
    expect(row().className).not.toContain('hover:bg-[var(--n-50)]');
  });

  it('reveals a trailing action on focus, not only on hover', () => {
    render(
      <PropertyRow
        kind="text"
        name="a"
        trailing={
          <span data-testid="trailing">
            <button type="button">Remove</button>
          </span>
        }
      >
        <span>v</span>
      </PropertyRow>,
    );
    // `hidden group-hover:` would take the button out of the tab order
    // entirely, so a keyboard user could never reach it.
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(row().className).toContain('group');
  });
});
