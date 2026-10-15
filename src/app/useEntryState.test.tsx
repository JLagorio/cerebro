import { useRef } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { useNavStore } from '@/stores/navStore';
import { useEntryScroll, useEntryState } from './useEntryState';
function Page() {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useEntryState('view.search', '');
  useEntryScroll(ref, 'canvas.scroll');
  return (
    <div ref={ref} data-testid="scroll">
      <input aria-label="Search" value={value} onChange={(event) => setValue(event.target.value)} />
    </div>
  );
}
beforeEach(() => {
  useNavStore.getState().setLiveCheck(null);
  useNavStore.getState().reset();
});
afterEach(cleanup);
it('stores values per visit and restores scroll on a reused canvas and a remount', () => {
  const mounted = render(<Page />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'alpha' } });
  const scroll = screen.getByTestId('scroll');
  scroll.scrollTop = 300;
  scroll.scrollLeft = 20;
  act(() => useNavStore.getState().navigate({ kind: 'settings' }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  scroll.scrollTop = 1;
  scroll.scrollLeft = 2;
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'beta' } });
  act(() => useNavStore.getState().back());
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('alpha');
  expect(scroll.scrollTop).toBe(300);
  expect(scroll.scrollLeft).toBe(20);
  mounted.unmount();
  render(<Page />);
  expect(screen.getByTestId('scroll').scrollTop).toBe(300);
  act(() => useNavStore.getState().forward());
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('beta');
  expect(screen.getByTestId('scroll').scrollTop).toBe(1);
});
it('a fresh visit never takes a previous visit’s search', () => {
  render(<Page />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'old' } });
  act(() => useNavStore.getState().navigate({ kind: 'settings' }));
  act(() => useNavStore.getState().navigate({ kind: 'home' }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
});
