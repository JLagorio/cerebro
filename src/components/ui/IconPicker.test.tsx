// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconPicker } from './IconPicker';

afterEach(cleanup);

describe('IconPicker (M16.26)', () => {
  it('narrows the grid as you type', () => {
    render(<IconPicker value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'rocket' } });
    expect(screen.getByLabelText('Icon rocket')).toBeTruthy();
    expect(screen.queryByLabelText('Icon calendar')).toBeNull();
  });

  it('says so rather than showing an empty grid', () => {
    render(<IconPicker value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'zzzzz' } });
    expect(screen.getByText(/No icons match/)).toBeTruthy();
  });

  /**
   * The bug this picker inherited from `TypeStyleDialog`, which listed every
   * lucide export kebab-cased with nothing checking the result.
   *
   * The two conversions are not inverses: `Icon` reads a name by PascalCasing
   * each dash-separated word, and `ArrowDownAZ` kebabs to `arrow-down-az`,
   * which comes back as `ArrowDownAz` and resolves to nothing. Four tiles
   * therefore drew M15.7's dashed-square fallback, and picking one wrote a
   * dead name into the vault's YAML — the M15.9 bug class, at scale.
   *
   * Asserted through the RENDERED grid rather than the module's list, because
   * the list is what was wrong: `data-unknown-icon` is the marker `Icon` puts
   * on the fallback.
   */
  it('never offers an icon that renders as the unknown-name fallback', () => {
    render(<IconPicker value={null} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Search icons'), { target: { value: 'az' } });
    expect(document.querySelectorAll('[data-unknown-icon]')).toHaveLength(0);
    // Not a vacuous pass: "az" does match names, they are just resolvable ones.
    expect(screen.queryByLabelText('Icon arrow-down-az')).toBeNull();
  });

  it('the clear tile is offered only when the caller has a fallback to name', () => {
    const onClear = vi.fn();
    const { unmount } = render(<IconPicker value="rocket" onChange={vi.fn()} />);
    expect(screen.queryByLabelText('Use the table icon')).toBeNull();
    unmount();
    render(
      <IconPicker
        value="rocket"
        onChange={vi.fn()}
        clear={{ label: 'Use the table icon', icon: 'table-2', onClear }}
      />,
    );
    fireEvent.click(screen.getByLabelText('Use the table icon'));
    expect(onClear).toHaveBeenCalled();
  });
});
