import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Icon, resolveIcon } from '@/components/ui/Icon';

afterEach(cleanup);

const paths = (el: Element | null) => el?.querySelectorAll('path,rect,circle,line,polyline').length;

describe('Icon', () => {
  it('renders a known lucide icon', () => {
    const { container } = render(<Icon name="target" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    expect(paths(svg)).toBeGreaterThan(0);
  });

  // The whole reason "Work item" had an invisible glyph everywhere: lucide
  // renamed CheckSquare to SquareCheck and vaults still say `check-square`.
  it('resolves a renamed lucide icon through the alias table', () => {
    expect(resolveIcon('check-square').Comp).toBe(resolveIcon('square-check').Comp);
    expect(resolveIcon('alert-triangle').Comp).toBe(resolveIcon('triangle-alert').Comp);
    expect(resolveIcon('x-circle').Comp).toBe(resolveIcon('circle-x').Comp);
  });

  it('draws a visible placeholder instead of an empty svg for an unknown name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { container } = render(<Icon name="definitely-not-an-icon" />);
      const svg = container.querySelector('svg');
      expect(svg).toBeTruthy();
      // The old behaviour was a <svg> with no children at all.
      expect(paths(svg)).toBeGreaterThan(0);
      expect(svg?.getAttribute('data-unknown-icon')).toBe('definitely-not-an-icon');
    } finally {
      warn.mockRestore();
    }
  });

  it('warns once per unknown name in dev', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      render(<Icon name="another-missing-icon" />);
      render(<Icon name="another-missing-icon" />);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('another-missing-icon');
    } finally {
      warn.mockRestore();
    }
  });
});
