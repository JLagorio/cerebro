import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TurnItem } from './elements/turn';
import { StepItem } from './toolRenderers';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('a step whose result is malformed draws unavailable, and its neighbours still draw (M93.12)', () => {
  const good = {
    kind: 'reasoning',
    key: 'good',
    part: { kind: 'reasoning', text: 'Weighing the two drafts', streaming: false },
  } as unknown as TurnItem;
  // An old archived turn, say, whose reasoning part never arrived.
  const malformed = { kind: 'reasoning', key: 'bad' } as unknown as TurnItem;
  render(
    <>
      <div data-testid="bad-step">
        <StepItem item={malformed} streaming={false} onOpenPath={vi.fn()} />
      </div>
      <div data-testid="good-step">
        <StepItem item={good} streaming={false} onOpenPath={vi.fn()} />
      </div>
    </>,
  );
  expect(
    within(screen.getByTestId('bad-step')).getByTestId('section-unavailable').textContent,
  ).toContain('This step stopped drawing');
  const neighbour = screen.getByTestId('good-step');
  expect(within(neighbour).queryByTestId('section-unavailable')).toBeNull();
  expect(neighbour.childElementCount).toBeGreaterThan(0);
});
