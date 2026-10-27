import { describe, expect, it } from 'vitest';
import { chevronClass, rowClass } from '@/app/sidebarChrome';

/**
 * A fold's chevron (app/shell.css `.cb-chevron`): every tree and section
 * header draws `chevron-right` and turns it, so the class is the whole state.
 */
describe('chevronClass', () => {
  it('turns the one chevron rather than naming another glyph', () => {
    expect(chevronClass(false)).toBe('cb-chevron');
    expect(chevronClass(true)).toBe('cb-chevron cb-chevron--open');
  });
});

/**
 * The one row class every nav row wears — Sidebar's destinations and sections,
 * and CollectionTree's nodes. Asserted here rather than in either consumer
 * because it is what makes a row in one look like a row in the other.
 */
describe('rowClass', () => {
  it('declares its hover wash (M46.2 Task 3)', () => {
    // The nav is the surface a pointer crosses fastest — a dozen rows in one
    // flick. Undeclared, the wash computes to `transition: all`, the CSS
    // initial value, and strobes on the way past; `motion-hover` is 20ms.
    expect(rowClass(false)).toContain('motion-hover');
    expect(rowClass(false)).toContain('hover:bg-n-100');
  });

  it('declares it on the SELECTED row too, so the wash is timed either way', () => {
    // Selected rows retain their neutral fill on hover; their timing class
    // stays explicit alongside the selected styling.
    expect(rowClass(true)).toContain('motion-hover');
    expect(rowClass(true)).toContain('cb-nav-row--selected');
  });

  it('never animates position or size — a nav row must not move', () => {
    for (const active of [true, false]) {
      expect(rowClass(active)).not.toContain('motion-move');
    }
  });
});
