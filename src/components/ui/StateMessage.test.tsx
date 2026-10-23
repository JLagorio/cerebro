import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { StateMessage } from './StateMessage';

it('keeps a failed read distinct from an empty read and exposes recovery', () => {
  const view = render(
    <StateMessage
      state="unavailable"
      title="Runs could not be read"
      action={<button>Try again</button>}
    >
      Their status is unknown.
    </StateMessage>,
  );
  expect(screen.getByTestId('section-unavailable').getAttribute('data-state')).toBe('unavailable');
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  view.rerender(<StateMessage state="empty" title="No runs yet" />);
  expect(screen.queryByTestId('section-unavailable')).toBeNull();
  expect(screen.getByText('No runs yet')).toBeTruthy();
});

it('announces loading as status without an animated-only indicator', () => {
  render(<StateMessage state="loading" title="Reading history…" />);
  expect(screen.getByRole('status').textContent).toContain('Reading history…');
});
