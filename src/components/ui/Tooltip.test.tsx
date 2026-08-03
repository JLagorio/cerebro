import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from '@/components/ui/Tooltip';
import { IconButton } from '@/components/ui/IconButton';
import { hasLayers, resetLayers } from '@/components/ui/layers';

afterEach(cleanup);
// Layers are module state; a case that leaves one pushed would make every
// later assertion about ownership pass for the wrong reason.
beforeEach(() => resetLayers());

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

  /**
   * …and dismisses ONLY itself (M16.35).
   *
   * The listener above used to be a bubble-phase `window` handler that
   * stopped nothing and registered no layer, so the same keystroke reached
   * every global handler behind it — one Escape over a header button hid the
   * hint and closed the whole record panel with it.
   */
  it('keeps that Escape away from listeners behind it', async () => {
    const user = userEvent.setup();
    const behind = vi.fn();
    // Exactly how DetailPanel listens.
    window.addEventListener('keydown', behind);
    try {
      render(
        <Tooltip label="Archive this" delayMs={0}>
          <button type="button">go</button>
        </Tooltip>,
      );
      await user.hover(screen.getByRole('button'));
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeTruthy());
      behind.mockClear();

      await user.keyboard('{Escape}');
      expect(behind).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    } finally {
      window.removeEventListener('keydown', behind);
    }
  });

  /**
   * A tooltip takes its Escape without being modal (M16.35).
   *
   * It registers as a layer of kind `tooltip`, which every question about the
   * innermost SURFACE skips. Counting as one would hand a focus-trapped
   * popover's Tab to a bubble floating over it — and Tab inside a trapped
   * popover is exactly what makes a tooltip appear.
   */
  it('does not count as a dismissable surface while it is up', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip label="Archive this" delayMs={0}>
        <button type="button">go</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole('button'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeTruthy());

    expect(hasLayers()).toBe(false);
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
