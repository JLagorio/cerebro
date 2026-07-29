// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoBadge } from './DemoBadge';

describe('DemoBadge', () => {
  afterEach(() => {
    cleanup();
    delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
  });

  it('marks the window when the backend is mocked', () => {
    render(<DemoBadge />);
    expect(screen.getByTestId('demo-badge')).toBeTruthy();
    // The badge is only useful if it names the way out.
    expect(screen.getByRole('tooltip').textContent).toContain('pnpm dev:app');
  });

  it('renders nothing in the real app', () => {
    (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
    render(<DemoBadge />);
    expect(screen.queryByTestId('demo-badge')).toBeNull();
  });
});
