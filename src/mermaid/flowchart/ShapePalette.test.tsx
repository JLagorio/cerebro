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

  it('every one of the 48 registry shapes is reachable', () => {
    render(<ShapePalette current={null} onPick={() => {}} onClose={() => {}} />);
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-label')?.startsWith('Shape: ') === true);
    expect(buttons).toHaveLength(48);
  });
});
