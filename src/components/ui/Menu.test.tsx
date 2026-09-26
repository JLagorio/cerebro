import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MenuItem, MenuLabel, MenuSeparator, MenuSurface } from '@/components/ui/Menu';

afterEach(cleanup);

/**
 * Six surfaces had hand-rolled this and only one of them — `ContextMenu` —
 * could be driven from a keyboard at all (M16.7).
 */
describe('MenuSurface', () => {
  it('focuses the first item on open, so the keyboard has somewhere to start', () => {
    render(
      <MenuSurface>
        <MenuItem label="First" onSelect={() => {}} />
        <MenuItem label="Second" onSelect={() => {}} />
      </MenuSurface>,
    );
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));
  });

  it('walks the items with the arrow keys and stops at both ends', async () => {
    const user = userEvent.setup();
    render(
      <MenuSurface>
        <MenuItem label="First" onSelect={() => {}} />
        <MenuItem label="Second" onSelect={() => {}} />
        <MenuItem label="Third" onSelect={() => {}} />
      </MenuSurface>,
    );
    const at = (name: string) => screen.getByRole('menuitem', { name });

    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(at('Second'));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(at('Third'));
    // Clamped, not wrapped: a menu that wraps loses a keyboard user's place.
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(at('Third'));
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(at('First'));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(at('First'));
  });

  it('skips separators and section labels, which are not stops', async () => {
    const user = userEvent.setup();
    render(
      <MenuSurface>
        <MenuItem label="First" onSelect={() => {}} />
        <MenuSeparator />
        <MenuLabel>Section</MenuLabel>
        <MenuItem label="Second" onSelect={() => {}} />
      </MenuSurface>,
    );
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second' }));
  });

  // A menu that opens over an input it owns — the property menu's rename box
  // — must leave Home and End to the caret.
  it('leaves Home and End alone while a text input has focus', async () => {
    const user = userEvent.setup();
    render(
      <MenuSurface>
        <input aria-label="Rename" defaultValue="abc" />
        <MenuItem label="Item" onSelect={() => {}} />
      </MenuSurface>,
    );
    const input = screen.getByLabelText('Rename');
    expect(document.activeElement).toBe(input);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(input);
  });

  it('can be told not to steal focus', () => {
    render(
      <MenuSurface autoFocus={false}>
        <MenuItem label="First" onSelect={() => {}} />
      </MenuSurface>,
    );
    expect(document.activeElement).toBe(document.body);
  });
});

describe('MenuItem', () => {
  it('declares its hover wash — a menu is READ by sweeping down it', () => {
    // M46.2 Task 3: undeclared, the wash computes to `transition: all`, the
    // CSS initial value, and strobes as the pointer crosses the stack.
    // `motion-hover` is 20ms ease-in — declared, not slow.
    render(
      <MenuSurface>
        <MenuItem label="First" onSelect={() => {}} />
      </MenuSurface>,
    );
    const item = screen.getByRole('menuitem', { name: 'First' });
    expect(item.className).toContain('motion-hover');
    // Never `motion-move`: a menu item that slid or resized under the pointer
    // would move the target the user is already aiming at.
    expect(item.className).not.toContain('motion-move');
  });

  it('is a menuitem, and fires on click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <MenuSurface>
        <MenuItem icon="trash-2" label="Delete" danger onSelect={onSelect} />
      </MenuSurface>,
    );
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  // A disabled item is still a menuitem in the DOM. Landing an arrow key on
  // one strands a keyboard user on something that cannot respond, with
  // nothing to say why.
  it('does not fire, or take an arrow-key stop, while disabled', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <MenuSurface>
        <MenuItem label="Enabled" onSelect={() => {}} />
        <MenuItem label="Off" disabled onSelect={onSelect} />
        <MenuItem label="Last" onSelect={() => {}} />
      </MenuSurface>,
    );
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Enabled' }));
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Last' }));

    await user.click(screen.getByRole('menuitem', { name: 'Off' }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows the current value beside the label rather than hiding it a level down', () => {
    render(
      <MenuSurface>
        <MenuItem label="Edit property" hint="Select" submenu onSelect={() => {}} />
      </MenuSurface>,
    );
    expect(screen.getByRole('menuitem', { name: /Edit property/ }).textContent).toContain('Select');
  });
});
