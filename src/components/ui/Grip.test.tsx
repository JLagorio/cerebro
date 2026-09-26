import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Grip, GRIP_GLYPH, gripClass } from '@/components/ui/Grip';

/**
 * The measured grip, per kind (M46.2 Task 6). Numbers are quoted from
 * `docs/superpowers/specs/2026-08-29-notion-drag-and-row-reference.md` §B;
 * what travels is the GEOMETRY, the cursor and the timing — the ink is ours.
 */
afterEach(cleanup);

describe('gripClass', () => {
  it('gives both measured kinds the same 18 x 24 slot (§B1, §B7)', () => {
    // The slot is the whole point of unifying four geometries onto one: a
    // 13 x 13 grip is a 169px² target where Notion's is 432px².
    for (const kind of ['row', 'block'] as const) {
      expect(gripClass(kind)).toContain('h-6');
      expect(gripClass(kind)).toContain('w-[18px]');
    }
  });

  it('gives the row grip no background and no radius of its own (§B4)', () => {
    // "We paint a second, smaller highlight inside the row's highlight" was
    // the baseline's B4 finding. The row's wash is the only wash.
    expect(gripClass('row')).not.toContain('rounded');
    expect(gripClass('row')).not.toContain('hover:bg-');
  });

  it('gives the block handle a 4px radius and its own wash (§B7)', () => {
    expect(gripClass('block')).toContain('rounded-xs');
    expect(gripClass('block')).toContain('hover:bg-n-100');
  });

  it('inks a block handle DIMMER than a row grip (§B7)', () => {
    // Notion's block glyph is rgb(125,122,117) against the property grip's
    // rgb(173,169,163). --n-300 is the step below --n-400 in both themes.
    expect(gripClass('row')).toContain('text-n-400');
    expect(gripClass('block')).toContain('text-n-300');
  });

  it('grabs, and never says grabbing (§B6)', () => {
    // `grabbing` belongs to the dragged subtree once a drag STARTS. There is
    // no `:active { grabbing }` on any grip Notion ships.
    for (const kind of ['row', 'block', 'tab'] as const) {
      expect(gripClass(kind)).toContain('cursor-grab');
      expect(gripClass(kind)).not.toContain('cursor-grabbing');
      expect(gripClass(kind)).not.toContain('active:');
    }
  });

  it('declares the reveal as movement, and never as a hover wash', () => {
    // What a grip does on hover is APPEAR. `motion-hover` is 20ms of colour;
    // an appearance timed at 20ms is a hard cut (M46.2 Task 3).
    for (const kind of ['row', 'block', 'tab'] as const) {
      expect(gripClass(kind)).toContain('motion-move');
      expect(gripClass(kind)).not.toContain('motion-hover');
    }
  });

  it('keeps the tab grip inside the 10px of dead padding it lives in', () => {
    // Transposed, not resized: an 18px slot in a horizontal strip would shove
    // every tab sideways on hover, which is the one thing §B1 forbids.
    expect(gripClass('tab')).toContain('w-2.5');
    expect(gripClass('tab')).not.toContain('w-[18px]');
    // No height — the call site's `inset-y-*` owns it.
    expect(gripClass('tab')).not.toContain('h-6');
  });
});

describe('Grip', () => {
  it('draws a 16px mark on a row and a 20px one on a block (§B3, §B7)', () => {
    expect(GRIP_GLYPH.row).toBe(16);
    expect(GRIP_GLYPH.block).toBe(20);
    render(<Grip kind="block" data-testid="g" />);
    const svg = screen.getByTestId('g').querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('20');
  });

  it('is a row grip unless told otherwise', () => {
    render(<Grip data-testid="g" />);
    expect(screen.getByTestId('g').className).toBe(gripClass('row'));
  });

  it('appends the placement and reveal a call site passes, rather than replacing them', () => {
    render(<Grip data-testid="g" className="absolute inset-0 opacity-0 group-hover:opacity-100" />);
    const cls = screen.getByTestId('g').className;
    expect(cls).toContain('cursor-grab');
    expect(cls).toContain('group-hover:opacity-100');
  });

  it('passes the drag props straight through, ref included', () => {
    // Every call site spreads either `useSortableList().gripProps` (which
    // carries role/tabIndex/aria-label and the keyboard path) or dnd-kit's
    // attributes+listeners. A primitive that swallowed any of them would take
    // the keyboard reorder with it — the place we are AHEAD of Notion.
    let node: HTMLElement | null = null;
    render(
      <Grip
        ref={(el) => {
          node = el;
        }}
        role="button"
        tabIndex={0}
        aria-label="Reorder Status, position 2 of 5"
        data-sortable-grip="status"
      />,
    );
    const el = screen.getByRole('button', { name: 'Reorder Status, position 2 of 5' });
    expect(el.getAttribute('data-sortable-grip')).toBe('status');
    expect(el.tabIndex).toBe(0);
    expect(node).toBe(el);
  });
});
