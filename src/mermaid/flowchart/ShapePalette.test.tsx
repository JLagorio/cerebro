import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ShapePalette } from './ShapePalette';

describe('ShapePalette', () => {
  it('renders the four categories and picks a shape', async () => {
    const onPick = vi.fn();
    render(<ShapePalette current="rect" onPick={onPick} onClose={() => {}} />);
    expect(screen.getByText('Basic')).toBeTruthy();
    expect(screen.getByText('Process')).toBeTruthy();
    expect(screen.getByText('Technical')).toBeTruthy();
    expect(screen.getByText('Annotation')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Shape: Cloud' }));
    expect(onPick).toHaveBeenCalledWith('cloud');
  });

  it('marks the current shape', () => {
    render(<ShapePalette current="cloud" onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Shape: Cloud' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('search filters by name, label, and alias', async () => {
    render(<ShapePalette current={null} onPick={() => {}} onClose={() => {}} />);
    const search = screen.getByLabelText('Search shapes');
    await userEvent.type(search, 'database');
    expect(screen.getByRole('button', { name: 'Shape: Database' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Shape: Cloud' })).toBeNull();
    await userEvent.clear(search);
    await userEvent.type(search, 'terminal'); // stadium's registry alias
    expect(screen.getByRole('button', { name: 'Shape: Stadium' })).toBeTruthy();
  });

  it('a query nothing matches says so instead of showing an empty grid', async () => {
    render(<ShapePalette current={null} onPick={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Search shapes'), 'zzzz');
    expect(screen.getByText('No shapes match.')).toBeTruthy();
    expect(screen.queryByText('Basic')).toBeNull();
  });

  // Before this landed, reaching Cloud from the search box took 40 Tab
  // presses and Enter picked nothing at all.
  it('Enter takes the top match once a query has narrowed the list', async () => {
    const onPick = vi.fn();
    render(<ShapePalette current={null} onPick={onPick} onClose={() => {}} />);
    const search = screen.getByLabelText('Search shapes');
    await userEvent.type(search, 'clou{Enter}');
    expect(onPick).toHaveBeenCalledWith('cloud');
  });

  it('Enter on an UNFILTERED grid picks nothing — every shape is "first"', async () => {
    const onPick = vi.fn();
    render(<ShapePalette current={null} onPick={onPick} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Search shapes'), '{Enter}');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('Enter with no match picks nothing', async () => {
    const onPick = vi.fn();
    render(<ShapePalette current={null} onPick={onPick} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Search shapes'), 'zzzz{Enter}');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('focus is trapped: Tab from the last control returns into the palette', async () => {
    render(<ShapePalette current={null} onPick={() => {}} onClose={() => {}} />);
    const palette = screen.getByTestId('shape-palette');
    const search = screen.getByLabelText('Search shapes');
    search.focus();
    // Walk well past the 49 focusable controls; focus must never leave.
    for (let i = 0; i < 60; i += 1) {
      await userEvent.tab();
      expect(palette.contains(document.activeElement), `after ${i + 1} tabs`).toBe(true);
    }
  }, 60_000);

  it('the categories are headings, and the search box is a search box', () => {
    render(<ShapePalette current={null} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Basic',
      'Process',
      'Technical',
      'Annotation',
    ]);
    expect(screen.getByLabelText('Search shapes').getAttribute('type')).toBe('search');
  });

  it('every one of the 48 registry shapes is reachable', () => {
    render(<ShapePalette current={null} onPick={() => {}} onClose={() => {}} />);
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-label')?.startsWith('Shape: ') === true);
    expect(buttons).toHaveLength(48);
  });
});
