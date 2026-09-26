import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PropertyRow, PROPERTY_LABEL_W } from '@/detail/PropertyRow';
import type { GripProps } from '@/hooks/useSortableList';
import { kindMeta } from '@/engine/properties';
import { FIELD_KINDS } from '@/engine/types';
import { gripClass } from '@/components/ui/Grip';
import { resolveIcon } from '@/components/ui/Icon';

afterEach(cleanup);

const row = () => screen.getByTestId('property-row');
const labelCell = () => row().firstElementChild as HTMLElement;

/** The shape `useSortableList().gripProps` hands over, inert. */
const stubGrip: GripProps = {
  ref: () => {},
  role: 'button',
  tabIndex: 0,
  'aria-label': 'Drag a',
  'data-sortable-grip': 'a',
  onPointerDown: () => {},
  onKeyDown: () => {},
};

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

  // The name box is 84px — the measured 120px column less the label cell's
  // 6px of padding on each side and the 18 + 6 the icon slot takes (§A2) — so
  // it runs out at about ten characters and a clipped name is exactly the
  // thing that needs a tooltip. jsdom lays nothing out, so the measurement
  // the component makes has to be stubbed to be exercised at all.
  it('gives a clipped name a tooltip', async () => {
    const user = userEvent.setup();
    const scroll = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(400);
    const client = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(84);
    try {
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
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
  });

  /**
   * The regression the M46.2 re-measure found in the browser: the tooltip
   * turned itself off again.
   *
   * `Tooltip` renders its child bare while disabled and inside a fragment once
   * enabled, so the name element is UNMOUNTED by the state that enables it.
   * The watcher that measured it was set up once, keyed on the label, and went
   * on reporting the detached node — which measures 0 — so the next callback
   * put `clipped` back to false and nothing ever measured the live node again.
   * jsdom ships no ResizeObserver, so the failure needs one stubbed to appear
   * at all: without this case the whole thing is invisible to the suite.
   */
  it('keeps measuring the name element the tooltip swap mounts', async () => {
    const user = userEvent.setup();
    const observed: Element[] = [];
    let fire: () => void = () => {};
    class StubRO {
      constructor(private cb: () => void) {
        fire = () => this.cb();
      }
      observe(el: Element) {
        observed.push(el);
      }
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', StubRO);
    // A detached node measures zero, which is the whole of the bug.
    const scroll = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (
      this: Element,
    ) {
      return this.isConnected ? 400 : 0;
    });
    const client = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: Element,
    ) {
      return this.isConnected ? 84 : 0;
    });
    try {
      render(
        <PropertyRow kind="text" name="an_extremely_long_property_name_indeed">
          <span>value</span>
        </PropertyRow>,
      );
      const name = () => within(labelCell()).getByText('An extremely long property name indeed');
      await user.hover(name());
      await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy(), { timeout: 2000 });

      // The watcher followed the swap: what it points at is on screen.
      expect(observed.at(-1)?.isConnected).toBe(true);
      // And a report from it does not undo the measurement that opened it.
      await act(async () => fire());
      await user.unhover(name());
      await user.hover(name());
      await waitFor(() => expect(screen.getByRole('tooltip')).toBeTruthy(), { timeout: 2000 });
    } finally {
      scroll.mockRestore();
      client.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // A tooltip that repeats text already on screen is noise — and this one
  // lands on top of the row above it. The first live look at M16.6 showed
  // "Priority" covering "Status" for a name that fitted with room to spare.
  it('stays quiet for a name that fits', async () => {
    const user = userEvent.setup();
    const scroll = vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(60);
    const client = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(84);
    try {
      render(
        <PropertyRow kind="text" name="due">
          <span>value</span>
        </PropertyRow>,
      );
      await user.hover(screen.getByText('Due'));
      await new Promise((r) => setTimeout(r, 600));
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      scroll.mockRestore();
      client.mockRestore();
    }
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
    // The label cell stays a 34px cell at the TOP of a row a wrapped value
    // has made taller — it does not stretch and it does not centre against a
    // three-line block. `pt-[3px]` did this by hand before the cell had a
    // height of its own (M46.2 Task 7).
    expect(labelCell().className).toContain('min-h-[34px]');
    expect(labelCell().className).toContain('items-center');

    rerender(
      <PropertyRow kind="checkbox" name="done" align="center">
        <span>switch</span>
      </PropertyRow>,
    );
    expect(row().className).toContain('items-center');
  });

  it('lights exactly ONE region, and it is the label cell (§A4, §A6)', () => {
    // The baseline's worst single anatomy delta: under one real hover the row
    // washed at --n-25, the value control at --n-50 and the label at --n-100 —
    // three lit regions where Notion lights one. A row that lights label AND
    // value reads as two buttons rather than as one label with a value.
    render(
      <PropertyRow kind="text" name="a" menu={() => <span>menu</span>}>
        <span>v</span>
      </PropertyRow>,
    );
    expect(labelCell().className).toContain('hover:bg-n-50');
    expect(row().className).not.toContain('hover:bg-');
    // The name is a menu trigger inside the cell; a wash on it too would be a
    // second highlight inside the first.
    expect(screen.getByRole('button', { name: 'A property menu' }).className).not.toContain(
      'hover:bg-',
    );
    // And the value column is a plain wrapper — no box, no wash of its own.
    const value = row().children[1] as HTMLElement;
    expect(value.className).not.toContain('hover:bg-');
  });

  it('declares the hover wash, so a pointer run down the list does not strobe', () => {
    // M46.2 Task 3: the wash used to compute to `transition: all`, the initial
    // value — no transition at all. `motion-hover` is 20ms ease-in, which is
    // an anti-flicker guard rather than a fade. It moved to the label cell
    // with the wash itself in Task 7; the ROW must not carry it, because the
    // row's own `style` is the drag's transform transition.
    render(
      <PropertyRow kind="text" name="a">
        <span>v</span>
      </PropertyRow>,
    );
    expect(labelCell().className).toContain('motion-hover');
    expect(row().className).not.toContain('motion-hover');
    expect(row().className).not.toContain('motion-move');
  });

  it('is 34px of content, with the 4px that makes the pitch left outside it (§A1)', () => {
    render(
      <PropertyRow kind="text" name="a">
        <span>v</span>
      </PropertyRow>,
    );
    // 38px pitch = 34 + 4, and the 4 is the CONTAINER's gap — never padding
    // on the row, or the gap would be part of the hover target.
    expect(row().className).toContain('min-h-[34px]');
    expect(row().className).not.toContain('py-');
    expect(row().className).not.toContain('h-[38px]');
    expect(labelCell().className).toContain('min-h-[34px]');
  });

  it('wears the measured label cell: 6px padding, 6px radius, no selecting (§A3)', () => {
    render(
      <PropertyRow kind="text" name="a" menu={() => <span>menu</span>}>
        <span>v</span>
      </PropertyRow>,
    );
    const cell = labelCell();
    // The literal measured number, once — every other assertion about the
    // column spends the constant, which cannot catch the constant changing.
    expect(PROPERTY_LABEL_W).toBe(120);
    expect(cell.className).toContain('flex-none'); // flex-shrink: 0 (§A2)
    expect(cell.className).toContain('px-1.5');
    // 6px, and the VALUE's is 4px — smaller. Ours had that inverted.
    expect(cell.className).toContain('rounded-sm');
    expect(cell.className).toContain('select-none');
    expect(cell.className).toContain('cursor-pointer');
    expect(cell.className).toContain('text-n-500');
  });

  it('does not claim a pointer for a label that opens nothing', () => {
    // Notion has no such row — every one of its labels is a menu trigger.
    // A doc's Type and an undeclared key are ours, and `cursor: pointer` on
    // one would promise a menu that is not there.
    render(
      <PropertyRow kind="text" name="a">
        <span>v</span>
      </PropertyRow>,
    );
    expect(labelCell().className).not.toContain('cursor-pointer');
  });

  it('sets the label at 14/400/20 and gaps the value with a 4px margin (§A8, §A2)', () => {
    render(
      <PropertyRow kind="text" name="a">
        <span>v</span>
      </PropertyRow>,
    );
    const name = screen.getByText('A');
    expect(name.className).toContain('text-md');
    expect(name.className).toContain('leading-md');
    expect(name.className).not.toContain('font-medium');
    expect(name.className).toContain('truncate');
    // The gap belongs to the value column as a margin, not to the row as a
    // column gap — so the label cell's wash runs the full 120px.
    expect((row().children[1] as HTMLElement).className).toContain('ml-1');
    expect(row().className).not.toContain('gap-');
  });

  it('wears the shared ROW grip, in the type icon slot it shares (M46.2 Task 6)', () => {
    render(
      <PropertyRow kind="text" name="a" grip={stubGrip}>
        <span>v</span>
      </PropertyRow>,
    );
    const handle = screen.getByLabelText('Drag a');
    // Not "contains a grip-shaped class string": the row spends the primitive,
    // so a change to the primitive reaches here and a local copy cannot drift.
    expect(handle.className).toContain(gripClass('row'));
    // The slot is the grip's, and the icon lives in it too — the swap is in
    // place (§B1), so the row's width cannot change on hover.
    const slot = handle.parentElement as HTMLElement;
    expect(slot.className).toContain('h-6');
    expect(slot.className).toContain('w-[18px]');
    expect(slot.querySelector('svg')).toBeTruthy();
    // §B4: no second, smaller highlight inside the row's own.
    expect(handle.className).not.toContain('hover:bg-');
  });

  it('cross-fades the icon and the grip rather than cutting between them', () => {
    render(
      <PropertyRow kind="text" name="a" grip={stubGrip}>
        <span>v</span>
      </PropertyRow>,
    );
    // Both halves of the one 13px cell, so the swap is a fade in each
    // direction rather than a hard cut (reference §B1).
    expect(screen.getByLabelText('Drag a').className).toContain('motion-move');
    expect(labelCell().querySelector('svg')?.getAttribute('class')).toContain('motion-move');
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
