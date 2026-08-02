// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
