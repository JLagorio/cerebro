// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceBodyEditor } from './SourceBodyEditor';
afterEach(cleanup);
it('preserves untouched CRLF and Unicode while emitting only changed raw source', () => {
  const change = vi.fn();
  render(<SourceBodyEditor raw={'\r\n<div>😀</div>\r\nkeep\r\n'} onChange={change} />);
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('textbox', { name: 'Page source' }), {
    target: { value: '\n<div>😀</div>\nchanged\n' },
  });
  expect(change).toHaveBeenCalledWith('\r\n<div>😀</div>\r\nchanged\r\n');
});
it('does not edit a read-only source presentation', () => {
  const change = vi.fn();
  render(<SourceBodyEditor raw="exact" readOnly onChange={change} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Page source' }), {
    target: { value: 'different' },
  });
  expect(change).not.toHaveBeenCalled();
});
