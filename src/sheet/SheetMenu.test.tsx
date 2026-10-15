import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SheetMenu } from './SheetMenu';
it('offers Ask on a read-only sheet while leaving every structural write disabled', () => {
  const ask = vi.fn();
  const change = vi.fn();
  render(
    <SheetMenu
      sheets={[{ name: 'Sheet1', cells: [] }]}
      sheet={0}
      area={{ row: 0, column: 0, width: 1, height: 1 }}
      disabled
      onChange={change}
      onAsk={ask}
    />,
  );
  fireEvent.click(screen.getByTestId('sheet-structure'));
  for (const option of screen.getAllByRole('menuitem'))
    if (option.textContent !== 'Ask about selection')
      expect((option as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Ask about selection' }));
  expect(ask).toHaveBeenCalledOnce();
  expect(change).not.toHaveBeenCalled();
});
