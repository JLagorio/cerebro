import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { NodeStyleMenu, STYLE_SWATCHES } from './NodeStyleMenu';

describe('NodeStyleMenu', () => {
  it('offers 12 swatches per row across fill, border, and text', () => {
    render(<NodeStyleMenu current={{}} onPatch={() => {}} onClose={() => {}} />);
    expect(STYLE_SWATCHES).toHaveLength(12);
    for (const label of ['Fill', 'Border', 'Text']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: /^Fill #/ })).toHaveLength(12);
  });

  it('a swatch patches its declaration; clear nulls it', async () => {
    const onPatch = vi.fn();
    render(<NodeStyleMenu current={{ fill: '#eef1fe' }} onPatch={onPatch} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Border #3d5bde' }));
    expect(onPatch).toHaveBeenCalledWith({ stroke: '#3d5bde' });
    await userEvent.click(screen.getByRole('button', { name: 'Clear fill' }));
    expect(onPatch).toHaveBeenCalledWith({ fill: null });
  });

  it('marks the current color', () => {
    render(<NodeStyleMenu current={{ color: '#de3b4e' }} onPatch={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Text #de3b4e' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  // Byte-identical output is caught in StructuralEditor's apply(), but only
  // when the existing line is already canonical: `style A fill: #eef1fe` would
  // re-emit reformatted and cost an undo step for a click that changed no
  // colour. The menu knows the answer without looking at the bytes.
  // A guarded press is still a press: it dismisses like every other one.
  // Returning early from onPatch alone left the menu hanging open on exactly
  // the swatch that was already current, while all eleven others closed it.
  it('re-picking the colour already applied patches nothing but still closes', async () => {
    const onPatch = vi.fn();
    const onClose = vi.fn();
    render(<NodeStyleMenu current={{ fill: '#eef1fe' }} onPatch={onPatch} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Fill #eef1fe' }));
    expect(onPatch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('clearing a declaration that is not there patches nothing but still closes', async () => {
    const onPatch = vi.fn();
    const onClose = vi.fn();
    render(<NodeStyleMenu current={{ fill: '#eef1fe' }} onPatch={onPatch} onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear border' }));
    expect(onPatch).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Clear fill' }));
    expect(onPatch).toHaveBeenCalledTimes(1);
  });

  // ShapePalette's search box takes focus on open; a sibling popover that
  // leaves focus on the trigger makes Tab mean something different a
  // centimetre away.
  it('opens with the first swatch focused', () => {
    render(<NodeStyleMenu current={{}} onPatch={() => {}} onClose={() => {}} />);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Fill #f6f7fa');
  });

  // A style value we did not write (`fill:red`, or a colour outside the ramp)
  // lights no swatch — the menu must not claim the node is unstyled OR point
  // at a colour it is not.
  it('a colour outside the palette marks no swatch', () => {
    render(<NodeStyleMenu current={{ fill: '#123456' }} onPatch={() => {}} onClose={() => {}} />);
    const pressed = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toEqual([]);
  });

  // The same keyboard contract ShapePalette settled in M29.32: two sibling
  // popovers on one toolbar behaving differently would be worse than either.
  it('focus is trapped: Tab from the last control returns into the menu', async () => {
    render(<NodeStyleMenu current={{}} onPatch={() => {}} onClose={() => {}} />);
    const menu = screen.getByTestId('node-style-menu');
    screen.getAllByRole('button')[0].focus();
    // Walk well past the 39 focusable controls; focus must never leave.
    for (let i = 0; i < 45; i += 1) {
      await userEvent.tab();
      expect(menu.contains(document.activeElement), `after ${i + 1} tabs`).toBe(true);
    }
  }, 60_000);

  it('the rows are headings, so a screen reader can walk them', () => {
    render(<NodeStyleMenu current={{}} onPatch={() => {}} onClose={() => {}} />);
    expect(screen.getAllByRole('heading').map((h) => h.textContent)).toEqual([
      'Fill',
      'Border',
      'Text',
    ]);
  });
});
