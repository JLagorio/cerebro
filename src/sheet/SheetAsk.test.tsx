import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { SheetAsk } from './SheetAsk';
import { NotePathContext } from '@/editor/notePath';
import { useUiStore } from '@/stores/uiStore';
it('commits the open draft and asks with the range label and page chip', () => {
  const ask = vi.spyOn(useUiStore.getState(), 'askAgent').mockImplementation(() => {});
  const before = vi.fn();
  const read = vi.fn(() => [{ address: 'A1', source: '1', shown: '1' }]);
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <NotePathContext.Provider value="notes/budget.md">
        <SheetAsk
          selection="Sheet1!A1:B2"
          beforeAsk={before}
          readCells={read}
          open={open}
          setOpen={setOpen}
        />
      </NotePathContext.Provider>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByTestId('sheet-ask'));
  fireEvent.change(screen.getByTestId('sheet-ask-input'), {
    target: { value: 'What is the total?' },
  });
  fireEvent.keyDown(screen.getByTestId('sheet-ask-input'), { key: 'Enter' });
  expect(before).toHaveBeenCalledOnce();
  expect(before.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
  expect(ask).toHaveBeenCalledWith(
    expect.stringContaining('source "1", shows "1"'),
    'notes/budget.md',
    'What is the total? · Sheet1!A1:B2',
  );
  ask.mockRestore();
});
it('has no ask action without a page context', () => {
  render(
    <SheetAsk
      selection="Sheet1!A1"
      beforeAsk={() => {}}
      readCells={() => []}
      open={false}
      setOpen={() => {}}
    />,
  );
  expect(screen.queryByTestId('sheet-ask')).toBeNull();
});
