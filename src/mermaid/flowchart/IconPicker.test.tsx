import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { icons as packIcons } from '@iconify-json/lucide';
import { resolveIcon } from '@/components/ui/Icon';
import { CURATED_ICONS, IconPicker } from './IconPicker';

describe('CURATED_ICONS', () => {
  it('every curated name resolves in BOTH renderers: lucide-react (preview) and the iconify pack (mermaid)', () => {
    // The preview draws with the app's own Icon component (lucide-react),
    // but mermaid resolves against @iconify-json/lucide. A name valid in one
    // and not the other would preview fine and render the blue "?" box (or
    // vice versa) — so membership in both sets is the whole test.
    for (const name of CURATED_ICONS) {
      expect(resolveIcon(name).Comp, `${name} missing from lucide-react`).not.toBeNull();
      const inPack = name in packIcons.icons || name in (packIcons.aliases ?? {});
      expect(inPack, `${name} missing from @iconify-json/lucide`).toBe(true);
    }
    expect(CURATED_ICONS.length).toBeGreaterThanOrEqual(60);
  });
});

describe('IconPicker', () => {
  it('picks a curated icon as a pack-prefixed value', async () => {
    const onPick = vi.fn();
    render(<IconPicker current={null} onPick={onPick} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Icon rocket' }));
    expect(onPick).toHaveBeenCalledWith('lucide:rocket');
  });

  it('search narrows the grid', async () => {
    render(<IconPicker current={null} onPick={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Search icons'), 'data');
    expect(screen.getByRole('button', { name: 'Icon database' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Icon rocket' })).toBeNull();
  });

  it('free text offers any lucide name, even one outside the curated list', async () => {
    const onPick = vi.fn();
    render(<IconPicker current={null} onPick={onPick} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Search icons'), 'satellite-dish');
    await userEvent.click(screen.getByRole('button', { name: 'Use lucide:satellite-dish' }));
    expect(onPick).toHaveBeenCalledWith('lucide:satellite-dish');
  });

  it('shows a clear action only when an icon is set', async () => {
    const onPick = vi.fn();
    const { rerender } = render(<IconPicker current={null} onPick={onPick} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Remove icon' })).toBeNull();
    rerender(<IconPicker current="lucide:zap" onPick={onPick} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove icon' }));
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it('marks the icon the node already carries', () => {
    render(<IconPicker current="lucide:zap" onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: 'Icon zap' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Icon star' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });

  // The same keyboard contract ShapePalette settled: 68 buttons behind a
  // search box is exactly where tabbing stops being a path.
  it('Enter takes the top match once a query has narrowed the list', async () => {
    const onPick = vi.fn();
    render(<IconPicker current={null} onPick={onPick} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Search icons'), 'rocke{Enter}');
    expect(onPick).toHaveBeenCalledWith('lucide:rocket');
  });

  it('Enter falls through to the free-text offer when nothing curated matches', async () => {
    const onPick = vi.fn();
    render(<IconPicker current={null} onPick={onPick} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Search icons'), 'satellite-dish{Enter}');
    expect(onPick).toHaveBeenCalledWith('lucide:satellite-dish');
  });

  it('Enter on an UNFILTERED grid picks nothing — every icon is "first"', async () => {
    const onPick = vi.fn();
    render(<IconPicker current={null} onPick={onPick} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Search icons'), '{Enter}');
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a query that matches nothing and is no lucide name says so', async () => {
    render(<IconPicker current={null} onPick={() => {}} onClose={() => {}} />);
    await userEvent.type(screen.getByLabelText('Search icons'), 'zz zz');
    expect(screen.getByText('No icons match.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Use lucide:/ })).toBeNull();
  });

  it('focus is trapped: Tab from the last control returns into the picker', async () => {
    render(<IconPicker current="lucide:zap" onPick={() => {}} onClose={() => {}} />);
    const picker = screen.getByTestId('mermaid-icon-picker');
    screen.getByLabelText('Search icons').focus();
    // Walk well past the focusable controls; focus must never leave.
    for (let i = 0; i < 80; i += 1) {
      await userEvent.tab();
      expect(picker.contains(document.activeElement), `after ${i + 1} tabs`).toBe(true);
    }
  }, 60_000);
});
