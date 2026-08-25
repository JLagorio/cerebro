// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from '@/stores/uiStore';
import { FavoriteStar } from './FavoriteStar';

describe('FavoriteStar', () => {
  beforeEach(() => {
    window.localStorage.removeItem('cerebro.favorites');
    useUiStore.setState({ favorites: [] });
  });
  afterEach(cleanup);

  it('reflects and toggles pinned state', async () => {
    render(<FavoriteStar path="a.md" />);
    const star = screen.getByRole('button', { name: 'Add to favorites' });
    expect(star.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(star);
    expect(useUiStore.getState().favorites).toEqual(['a.md']);
    expect(
      screen.getByRole('button', { name: 'Remove from favorites' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
