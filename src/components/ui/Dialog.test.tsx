import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ui/Dialog';

afterEach(cleanup);

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

  // It was aria-modal in name only: no Escape, no trap, no restore.
  it('names itself with its own title', () => {
    render(<Dialog open title="Create item" />);
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.querySelector(`[id="${labelledBy}"]`)?.textContent).toBe('Create item');
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} title="Create item" />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the card on open', () => {
    render(
      <Dialog open title="Create item">
        <button type="button">Inner</button>
      </Dialog>,
    );
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('leaves focus alone when a child already claimed it', () => {
    render(
      <Dialog open title="Create item">
        <input autoFocus aria-label="Query" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Query'));
  });

  it('restores focus to the opener when it closes', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(<Dialog open title="Create item" />);
    expect(document.activeElement).not.toBe(opener);
    rerender(<Dialog open={false} title="Create item" />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  // The case the plain restore missed (PR #7 review): an autofocusing child
  // takes focus during commit, before any effect here can read the opener, so
  // capturing it from one recorded QuickOpen's OWN input — a node unmounted
  // with the dialog, leaving focus on <body> after every close.
  it('restores focus to the opener even when a child autofocused inside', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(
      <Dialog open title="Find">
        <input autoFocus aria-label="Query" />
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('Query'));
    rerender(<Dialog open={false} title="Find" />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('wraps Tab from the last focusable back to the first', () => {
    render(
      <Dialog open title="Create item" primaryAction={{ label: 'Create' }}>
        <button type="button">Inner</button>
      </Dialog>,
    );
    const create = screen.getByRole('button', { name: 'Create' });
    create.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('wraps Shift+Tab from the first focusable back to the last', () => {
    render(
      <Dialog open title="Create item" primaryAction={{ label: 'Create' }}>
        <button type="button">Inner</button>
      </Dialog>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create' }));
  });
});
