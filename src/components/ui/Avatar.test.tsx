import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Avatar, AvatarGroup } from '@/components/ui/Avatar';

afterEach(cleanup);

describe('Avatar', () => {
  // It shipped eight raw pastel hexes and drew the initials in #fff on top of
  // them — every avatar in the app was below 2.5:1.
  it('draws initials in the inverse token on a DS avatar background', () => {
    render(<Avatar name="You" size={28} />);
    const el = screen.getByTitle('You');
    expect(el.textContent).toBe('Y');
    expect(el.style.color).toBe('var(--text-inverse)');
    expect(el.style.background).toMatch(/^var\(--avatar-[1-8]\)$/);
  });

  it('floors the initials at 10px so table-row avatars stay legible', () => {
    render(<Avatar name="Ana Rios" size={20} />);
    // 20 * 0.42 rounds to 8px without the floor.
    expect(screen.getByTitle('Ana Rios').style.fontSize).toBe('10px');
  });

  it('keeps the same colour for the same name', () => {
    const { container } = render(
      <>
        <Avatar name="Ana Rios" />
        <Avatar name="Ana Rios" />
      </>,
    );
    const [a, b] = [...container.querySelectorAll('span[title]')] as HTMLElement[];
    expect(a.style.background).toBe(b.style.background);
  });

  it('floors the +N overflow badge too', () => {
    render(<AvatarGroup names={['A One', 'B Two', 'C Three', 'D Four']} size={20} max={3} />);
    const badge = screen.getByText('+1') as HTMLElement;
    expect(badge.style.fontSize).toBe('10px');
  });
});
