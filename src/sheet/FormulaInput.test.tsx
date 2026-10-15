import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { FormulaInput } from './FormulaInput';
import { useEscapeLayer } from '@/components/ui/Popover';
const complete = vi.hoisted(() => vi.fn());
vi.mock('@/lib/ipc', () => ({ sheetComplete: complete }));
beforeEach(() => {
  complete.mockReset();
});
function setup(value = '=SU') {
  const outer = vi.fn();
  const keys = vi.fn();
  function Parent() {
    useEscapeLayer(outer, { kind: 'gesture', modal: false });
    const [text, setText] = useState(value);
    return (
      <div onKeyDown={keys}>
        <FormulaInput
          names={['Sheet1']}
          sheet={0}
          row={0}
          column={0}
          value={text}
          onChange={setText}
          label="Formula"
          testId="formula"
        />
      </div>
    );
  }
  render(<Parent />);
  const input = screen.getByTestId('formula') as HTMLTextAreaElement;
  act(() => input.focus());
  input.setSelectionRange(input.value.length, input.value.length);
  fireEvent.select(input);
  return { input, outer, keys };
}
it('offers an accessible list and inserts with Enter before the parent can commit', async () => {
  complete.mockResolvedValue({ expecting: [{ FunctionName: 'SU' }], replace_from: 0 });
  const { input, keys } = setup();
  await screen.findByTestId('sheet-completions');
  expect(input.getAttribute('role')).toBe('combobox');
  expect(input.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getAllByRole('option')[0].textContent).toBe('SUM');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input.value).toBe('=SUM(');
  expect(keys).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledWith(['Sheet1'], 0, 0, 0, '=SU', 3);
});
it('closes completion on the first Escape and leaves the outer draft for the second', async () => {
  complete.mockResolvedValue({ expecting: [{ FunctionName: 'SU' }], replace_from: 0 });
  const { input, outer } = setup();
  await screen.findByTestId('sheet-completions');
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByTestId('sheet-completions')).toBeNull();
  expect(outer).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(outer).toHaveBeenCalledOnce();
});
it('ignores an older completion after the text changes and preserves focus on mouse insert', async () => {
  let stale!: (value: unknown) => void;
  complete.mockReturnValueOnce(
    new Promise((resolve) => {
      stale = resolve;
    }),
  );
  complete.mockResolvedValue({ expecting: [{ FunctionName: 'AV' }], replace_from: 0 });
  const { input } = setup();
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  fireEvent.change(input, { target: { value: '=AV', selectionStart: 3 } });
  await screen.findByTestId('sheet-completions');
  await act(async () => stale({ expecting: [{ FunctionName: 'SU' }], replace_from: 0 }));
  expect(screen.getAllByRole('option')[0].textContent).toBe('AVERAGE');
  fireEvent.mouseDown(screen.getAllByRole('option')[0]);
  expect(input.value).toBe('=AVERAGE(');
  await waitFor(() => expect(document.activeElement).toBe(input));
});
it('does not ask for completion on plain text or while read only', async () => {
  setup('plain');
  await new Promise((resolve) => setTimeout(resolve, 90));
  expect(complete).not.toHaveBeenCalled();
});

it('retires a ready completion and its context when the draft becomes read only', async () => {
  complete.mockResolvedValue({ expecting: [{ FunctionName: 'SU' }], replace_from: 0 });
  const onChange = vi.fn(),
    onContext = vi.fn();
  const props = {
    names: ['Sheet1'],
    sheet: 0,
    row: 0,
    column: 0,
    value: '=SU',
    onChange,
    onContext,
    label: 'Formula',
    testId: 'formula',
  };
  const view = render(<FormulaInput {...props} />);
  const input = screen.getByTestId('formula');
  act(() => input.focus());
  await screen.findByTestId('sheet-completions');
  const option = screen.getAllByRole('option')[0];
  view.rerender(<FormulaInput {...props} readOnly />);
  expect(screen.queryByTestId('sheet-completions')).toBeNull();
  expect(onContext).toHaveBeenLastCalledWith(null);
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Tab' });
  fireEvent.mouseDown(option);
  expect(onChange).not.toHaveBeenCalled();
});
