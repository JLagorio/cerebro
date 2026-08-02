import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from '@/components/ui/Tooltip';
import { IconButton } from '@/components/ui/IconButton';

afterEach(cleanup);

/**
 * What the native `title` attribute could not do (M16.5), which is why 124
 * sites using it were not really tooltipped at all.
 */
describe('Tooltip', () => {
  it('shows on hover after the delay', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Archive this" delayMs={0}>
        <button type="button">go</button>
      </Tooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();

    await user.hover(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe('Archive this'));
  });

  it('hides again on unhover', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Archive this" delayMs={0}>
        <button type="button">go</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole('button'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeTruthy());

    await user.unhover(screen.getByRole('button'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });

  // `title` responds to hover only, so keyboard users never saw any of them.
  it('shows on focus', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Archive this" delayMs={0}>
        <button type="button">go</button>
      </Tooltip>,
    );
    await user.tab();
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeTruthy());
  });

  it('describes rather than names, so the label is not read twice', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Archive this" delayMs={0}>
        <button type="button" aria-label="Archive">
          go
        </button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole('button'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeTruthy());

    const described = screen.getByRole('button').closest('[aria-describedby]');
    expect(described).toBeTruthy();
    // The accessible name still comes from the control itself.
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Archive');
  });

  it('renders nothing for an empty label', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="" delayMs={0}>
        <button type="button">go</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole('button'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes on Escape without needing the pointer to move', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Archive this" delayMs={0}>
        <button type="button">go</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole('button'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeTruthy());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});

describe('IconButton tooltip', () => {
  it('no longer puts the label in a title attribute', () => {
    render(<IconButton icon="trash-2" label="Delete" />);
    expect(screen.getByRole('button').getAttribute('title')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Delete');
  });

  // The reason this moved off the button: a browser never renders `title` on
  // a disabled control, so the one case where a user most needs to be told
  // why a button will not respond was the one case that said nothing.
  it('still explains itself while disabled', async () => {
    const user = userEvent.setup();
    render(<IconButton icon="trash-2" label="Delete — not allowed here" disabled />);

    await user.hover(screen.getByRole('button'));
    await waitFor(
      () => expect(screen.getByRole('tooltip').textContent).toBe('Delete — not allowed here'),
      { timeout: 2000 },
    );
  });
});
