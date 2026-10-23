// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SectionHeader } from './SectionHeader';

describe('SectionHeader', () => {
  afterEach(cleanup);

  it('announces expanded state and toggles', async () => {
    const onToggle = vi.fn();
    render(<SectionHeader label="Agents" open onToggle={onToggle} />);
    const head = screen.getByRole('button', { name: 'Agents' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(head);
    expect(onToggle).toHaveBeenCalledOnce();
  });

  // One chevron, turned by the state the header announces, never traded for
  // another glyph; the actions it reveals fade (app/shell.css).
  it.each(['section', 'context'] as const)(
    'turns one chevron with its expanded state (%s)',
    (variant) => {
      const { rerender } = render(
        <SectionHeader
          variant={variant}
          label="Agents"
          open={false}
          onToggle={() => undefined}
          actions={[{ icon: 'plus', label: 'New agent', onClick: () => undefined }]}
        />,
      );
      const head = screen.getByRole('button', { name: 'Agents' });
      const chevron = () => head.querySelector('[data-icon="chevron-right"]')?.parentElement;
      expect(head.querySelectorAll('[data-icon^="chevron"]')).toHaveLength(1);
      expect(head.getAttribute('aria-expanded')).toBe('false');
      expect(chevron()?.classList.contains('cb-chevron')).toBe(true);
      expect(chevron()?.classList.contains('cb-chevron--open')).toBe(false);
      rerender(
        <SectionHeader
          variant={variant}
          label="Agents"
          open
          onToggle={() => undefined}
          actions={[{ icon: 'plus', label: 'New agent', onClick: () => undefined }]}
        />,
      );
      expect(head.querySelectorAll('[data-icon^="chevron"]')).toHaveLength(1);
      expect(head.getAttribute('aria-expanded')).toBe('true');
      expect(chevron()?.classList.contains('cb-chevron--open')).toBe(true);
      expect(screen.getByRole('button', { name: 'New agent' }).className).toContain('cb-reveal');
    },
  );

  it('renders hover actions that do not toggle the section', async () => {
    const onToggle = vi.fn();
    const onAdd = vi.fn();
    render(
      <SectionHeader
        label="Agents"
        open
        onToggle={onToggle}
        actions={[{ icon: 'plus', label: 'New agent', onClick: onAdd }]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'New agent' }));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('keeps a folded context header and its separate action reachable by keyboard', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    render(
      <SectionHeader
        variant="context"
        label="Knowledge"
        open={false}
        onToggle={onToggle}
        actions={[{ icon: 'arrow-up-right', label: 'Open Knowledge', onClick: onOpen }]}
      />,
    );
    const header = screen.getByRole('button', { name: 'Knowledge', expanded: false });
    const action = screen.getByRole('button', { name: 'Open Knowledge' });
    await user.tab();
    expect(document.activeElement).toBe(header);
    await user.keyboard('{Enter}');
    expect(onToggle).toHaveBeenCalledOnce();
    await user.tab();
    expect(document.activeElement).toBe(action);
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
