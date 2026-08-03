// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { ContextMenu } from './ContextMenu';

describe('ContextMenu', () => {
  afterEach(cleanup);

  const renderMenu = (onClose = vi.fn(), onSelect = vi.fn()) => {
    render(
      <ContextMenu
        x={40}
        y={40}
        items={[
          { icon: 'pencil', label: 'Rename', onSelect },
          { icon: 'trash-2', label: 'Move to Trash', danger: true, onSelect: vi.fn() },
        ]}
        onClose={onClose}
      />,
    );
    return { onClose, onSelect };
  };

  it('renders menu items and fires onSelect then closes', () => {
    const { onClose, onSelect } = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on backdrop click without selecting', () => {
    const { onClose, onSelect } = renderMenu();
    fireEvent.click(screen.getByTestId('context-menu-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('closes on Escape and moves focus with arrows', () => {
    const { onClose } = renderMenu();
    const first = screen.getByRole('menuitem', { name: 'Rename' });
    const second = screen.getByRole('menuitem', { name: 'Move to Trash' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * The menu takes focus on open and used to keep it (M16.35): dismissing left
   * `<body>` focused, so the row you right-clicked lost its place and the next
   * Tab restarted from the top of the document.
   */
  it('hands focus back to the row it was summoned from', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    try {
      const { unmount } = render(
        <ContextMenu
          x={40}
          y={40}
          items={[{ icon: 'pencil', label: 'Rename', onSelect: vi.fn() }]}
          onClose={vi.fn()}
        />,
      );
      // The menu focuses its first item during commit — later than the render
      // pass that must have already recorded the opener.
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Rename' }));
      unmount();
      expect(document.activeElement).toBe(opener);
    } finally {
      opener.remove();
    }
  });

  // Half the menu's items open a dialog or an inline rename field. Those hand
  // focus onward deliberately, and the restore above must not snatch it back.
  it('does not steal focus from a surface the selection opened', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    try {
      function Harness() {
        const [open, setOpen] = useState(true);
        const [renaming, setRenaming] = useState(false);
        return (
          <>
            {open && (
              <ContextMenu
                x={40}
                y={40}
                items={[{ icon: 'pencil', label: 'Rename', onSelect: () => setRenaming(true) }]}
                onClose={() => setOpen(false)}
              />
            )}
            {renaming && <input aria-label="New name" autoFocus />}
          </>
        );
      }
      render(<Harness />);
      fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
      expect(document.activeElement).toBe(screen.getByLabelText('New name'));
    } finally {
      opener.remove();
    }
  });
});
