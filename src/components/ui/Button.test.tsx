import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '@/components/ui/Button';

describe('Button', () => {
  it('renders children with secondary variant and md size by default', () => {
    render(<Button>Save view</Button>);
    const btn = screen.getByRole('button', { name: 'Save view' }) as HTMLButtonElement;
    expect(btn.className).toContain('cb-btn-secondary');
    expect(btn.className).toContain('cb-btn-md');
    expect(btn.type).toBe('button');
  });

  it('applies each variant class', () => {
    const variants = ['primary', 'secondary', 'ghost', 'danger'] as const;
    for (const variant of variants) {
      const { unmount } = render(<Button variant={variant}>{variant}</Button>);
      const btn = screen.getByRole('button', { name: variant });
      expect(btn.className).toContain(`cb-btn-${variant}`);
      unmount();
    }
  });

  it('applies size classes', () => {
    const { unmount } = render(<Button size="sm">Small</Button>);
    expect(screen.getByRole('button', { name: 'Small' }).className).toContain('cb-btn-sm');
    unmount();
    render(<Button size="lg">Large</Button>);
    expect(screen.getByRole('button', { name: 'Large' }).className).toContain('cb-btn-lg');
  });

  it('fires onClick, but not when disabled', () => {
    const onClick = vi.fn();
    const { unmount } = render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    unmount();

    const onClickDisabled = vi.fn();
    render(
      <Button disabled onClick={onClickDisabled}>
        Stop
      </Button>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onClickDisabled).not.toHaveBeenCalled();
  });
});
