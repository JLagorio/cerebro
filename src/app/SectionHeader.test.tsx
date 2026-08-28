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
});
