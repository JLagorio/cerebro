import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ui/Dialog';

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    render(<Dialog open={false} title="Create item" />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders title and children when open', () => {
    render(
      <Dialog open title="Create item">
        <p>Body content</p>
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Create item')).toBeTruthy();
    expect(screen.getByText('Body content')).toBeTruthy();
  });

  it('calls onClose from the close button', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Create item" />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on scrim mousedown but not on dialog mousedown', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Create item">
        <p>Body content</p>
      </Dialog>,
    );
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    const scrim = document.querySelector('.cb-dlg-scrim')!;
    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders footer actions and fires them', () => {
    const onPrimary = vi.fn();
    const onSecondary = vi.fn();
    render(
      <Dialog
        open
        title="Create item"
        primaryAction={{ label: 'Create', onClick: onPrimary }}
        secondaryAction={{ label: 'Cancel', onClick: onSecondary }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });
});
