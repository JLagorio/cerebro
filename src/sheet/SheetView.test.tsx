import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SheetView } from './SheetView';
import type { SheetState } from './useSheetWorkbook';

const state: SheetState = {
  status: 'ready',
  sheet: {
    ok: true,
    name: 'Budget',
    rows: 1,
    cols: 4,
    cells: [
      { row: 1, col: 1, kind: 'number', display: '0' },
      { row: 1, col: 2, kind: 'boolean', display: 'TRUE' },
      { row: 1, col: 3, kind: 'error', display: '#REF!' },
      { row: 1, col: 4, kind: 'text', display: 'long text' },
    ],
  },
};
describe('a read-only sheet', () => {
  it('pads to three rows, leaves blanks empty, and renders actual zero with its kind', () => {
    const { container } = render(
      <SheetView
        state={state}
        source="=B9,TRUE,=Missing!A1,long text"
        cells={[{ row: 1, col: 1, source: '=B9' }]}
      />,
    );
    expect(screen.getByTestId('sheet-name').textContent).toBe('Budget');
    expect(screen.getAllByTestId('sheet-cell')).toHaveLength(12);
    expect(container.querySelector('[data-address=A1]')?.textContent).toBe('0');
    expect(container.querySelector('[data-address=A2]')?.textContent).toBe('');
    expect(container.querySelector('[data-address=A2]')?.getAttribute('data-kind')).toBe('blank');
    expect(container.querySelector('[data-address=A1]')?.getAttribute('title')).toBe('=B9');
    expect(container.querySelector('[data-address=C1]')?.getAttribute('title')).toBe(
      "Points at a cell or sheet that isn't there.",
    );
    expect(container.querySelector('[data-address=B1]')?.className).toContain('text-center');
    expect(container.querySelector('[data-address=A1]')?.className).toContain('text-right');
  });
  it('shows neither values nor an empty grid while pending', () => {
    render(<SheetView state={{ status: 'pending', name: 'Budget' }} source="1200" />);
    expect(screen.getByTestId('sheet-pending').textContent).toContain('Calculating Budget');
    expect(screen.queryByTestId('sheet-grid')).toBeNull();
    expect(screen.queryByText('1200')).toBeNull();
  });
  it('shows a failure with source verbatim', () => {
    const source = '---\nformat: 2\n---\na,  b\n';
    render(
      <SheetView
        state={{
          status: 'unavailable',
          name: 'Sheet1',
          reason: 'fence',
          message: 'format problem',
        }}
        source={source}
      />,
    );
    expect(screen.getByTestId('sheet-unavailable').getAttribute('data-reason')).toBe('fence');
    expect(screen.getByTestId('sheet-source').textContent).toBe(source);
    expect(screen.queryByTestId('sheet-grid')).toBeNull();
  });
});
