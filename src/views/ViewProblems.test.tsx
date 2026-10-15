// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ViewProblem } from '@/engine/viewCheck';
import { ViewProblems } from './ViewProblems';

afterEach(cleanup);

const ghost = (name: string): ViewProblem => ({
  code: 'unknown_field',
  name,
  position: 'column',
});

describe('ViewProblems (M60.2b)', () => {
  it('says each problem in one line, as a status', () => {
    render(
      <ViewProblems
        source="Work item"
        problems={[
          { code: 'unknown_field', name: 'ghost_field', position: 'filter', filterPath: [0] },
          { code: 'unknown_option', name: 'status', position: 'filter', option: 'wip' },
        ]}
      />,
    );
    const strip = screen.getByTestId('view-problems');
    expect(strip.getAttribute('role')).toBe('status');
    expect(screen.getAllByTestId('view-problem').map((li) => li.textContent)).toEqual([
      '“ghost_field” in the filter: Work item has no property by that name.',
      '“wip” is not an option of Status.',
    ]);
  });

  it('names five, then counts the rest', () => {
    const problems = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(ghost);
    render(<ViewProblems source={null} problems={problems} />);
    expect(screen.getAllByTestId('view-problem')).toHaveLength(5);
    expect(screen.getByTestId('view-problems').textContent).toContain('and 2 more');
    expect(screen.getAllByTestId('view-problem')[0].textContent).toBe(
      '“a” in the columns: no database has a property by that name.',
    );
  });

  it('shows no count at exactly five', () => {
    render(<ViewProblems source={null} problems={['a', 'b', 'c', 'd', 'e'].map(ghost)} />);
    expect(screen.getByTestId('view-problems').textContent).not.toContain('more');
  });

  it('renders nothing for a clean view', () => {
    const { container } = render(<ViewProblems source="Work item" problems={[]} />);
    expect(container.innerHTML).toBe('');
  });
});
