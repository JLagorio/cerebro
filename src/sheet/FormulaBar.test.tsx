import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { FormulaBar } from './FormulaBar';
vi.mock('@/lib/ipc', () => ({ sheetComplete: vi.fn() }));
it('keeps the selected range readable and passes edits to the shared formula input', () => {
  const change = vi.fn();
  render(
    <FormulaBar
      address="A1:B2"
      value="12"
      readOnly={false}
      names={['Sheet1']}
      sheet={0}
      row={0}
      column={0}
      onChange={change}
      onFocus={() => {}}
      onBlur={() => {}}
    />,
  );
  expect(screen.getByTestId('sheet-address').textContent).toBe('A1:B2');
  fireEvent.change(screen.getByTestId('sheet-formula-input'), { target: { value: '13' } });
  expect(change).toHaveBeenCalledWith('13');
});
