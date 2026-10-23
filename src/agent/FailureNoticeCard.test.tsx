// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FailureNoticeCard, formatResetTime } from '@/agent/FailureNoticeCard';
import type { FailureNotice } from '@/agent/types';

afterEach(cleanup);

/** The not-signed-in notice, as conformance/failure/notices.json holds it. */
const NOT_SIGNED_IN: FailureNotice = {
  kind: 'not_signed_in',
  title: "Claude Code isn't signed in",
  body: 'Cerebro runs your own Claude Code, and it has no sign-in on this Mac. Open Terminal, run claude, and type /login. Then try again.',
  action: 'open_settings',
  resets_at: null,
  window: null,
  cli_version: '2.1.250',
};

const USAGE_LIMIT: FailureNotice = {
  kind: 'usage_limit',
  title: "You've reached your Claude usage limit",
  body: 'Claude Code stopped because your weekly limit is used up. Background work waits until then.',
  action: null,
  resets_at: '2026-01-01T00:00:00Z',
  window: 'weekly',
  cli_version: '2.1.250',
};

const card = () => screen.getByTestId('failure-notice');

describe('FailureNoticeCard (M56.4)', () => {
  it('shows the title, the body and the version that reported it', () => {
    render(<FailureNoticeCard notice={NOT_SIGNED_IN} />);
    expect(screen.getByRole('group', { name: "Claude Code isn't signed in" })).toBe(card());
    expect(card().textContent).toContain(NOT_SIGNED_IN.body);
    expect(card().textContent).toContain('Reported by Claude Code 2.1.250');
    expect(screen.queryByTestId('failure-notice-reset')).toBeNull();
  });

  it('formats a reset as weekday, month, day and time', () => {
    expect(formatResetTime('2026-01-01T00:00:00Z', 'en-US', 'UTC')).toBe('Thu, Jan 1, 12:00 AM');
    expect(formatResetTime('2026-07-14T17:30:00Z', 'en-US', 'UTC')).toBe('Tue, Jul 14, 5:30 PM');
    expect(formatResetTime('not a date', 'en-US', 'UTC')).toBe('not a date');
  });

  it('names when a limit resets, or says it was not reported', () => {
    render(<FailureNoticeCard notice={USAGE_LIMIT} />);
    expect(screen.getByTestId('failure-notice-reset').textContent).toBe(
      `Resets ${formatResetTime('2026-01-01T00:00:00Z')}`,
    );
    cleanup();
    render(<FailureNoticeCard notice={{ ...USAGE_LIMIT, resets_at: null }} />);
    expect(screen.getByTestId('failure-notice-reset').textContent).toBe('Reset time not reported');
  });

  it('renders the words of a kind this build has never heard of', () => {
    render(
      <FailureNoticeCard
        notice={{
          kind: 'teleport_failed',
          title: 'The teleporter is down',
          body: 'Walk instead.',
          action: 'teleport_again',
          resets_at: null,
          window: null,
          cli_version: null,
        }}
        actions={{ open_settings: vi.fn() }}
      />,
    );
    expect(card().textContent).toContain('The teleporter is down');
    expect(card().textContent).toContain('Walk instead.');
    expect(card().textContent).not.toContain('Reported by');
    expect(screen.queryByTestId('failure-notice-action')).toBeNull();
  });

  it('draws a button only for an action it has a handler for', () => {
    render(<FailureNoticeCard notice={NOT_SIGNED_IN} />);
    expect(screen.queryByTestId('failure-notice-action')).toBeNull();
    cleanup();
    const openSettings = vi.fn();
    render(<FailureNoticeCard notice={NOT_SIGNED_IN} actions={{ open_settings: openSettings }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps what Claude Code said behind a disclosure', () => {
    render(<FailureNoticeCard notice={NOT_SIGNED_IN} raw="Not logged in · Please run /login" />);
    const raw = screen.getByTestId('failure-notice-raw');
    expect(raw.tagName).toBe('DETAILS');
    expect(raw.hasAttribute('open')).toBe(false);
    expect(raw.querySelector('summary')?.textContent).toBe('What Claude Code said');
    expect(raw.textContent).toContain('Not logged in · Please run /login');
  });

  it('shows what Claude Code said without its tool-error tags, scrolling when long', () => {
    render(
      <FailureNoticeCard
        notice={NOT_SIGNED_IN}
        raw="<tool_use_error>Not logged in · Please run /login</tool_use_error>"
      />,
    );
    const said = screen.getByTestId('failure-notice-raw').querySelector('p')!;
    expect(said.textContent).toBe('Not logged in · Please run /login');
    expect(said.className).toContain('overflow-auto');
  });

  it('keeps its words, and adds the stack Claude Code printed as a Stack Trace', () => {
    const raw = 'Error: boom\n    at load (notes/plan.md:3:1)\n    at node:internal/main:1:1';
    render(<FailureNoticeCard notice={NOT_SIGNED_IN} raw={raw} onOpenPath={vi.fn()} />);
    expect(card().textContent).toContain(NOT_SIGNED_IN.title);
    expect(card().querySelector('[data-slot="stack-trace"]')).not.toBeNull();
    cleanup();
    render(<FailureNoticeCard notice={NOT_SIGNED_IN} raw="Not logged in · Please run /login" />);
    expect(card().querySelector('[data-slot="stack-trace"]')).toBeNull();
  });

  it('offers Retry as the red box did', () => {
    const onRetry = vi.fn();
    render(<FailureNoticeCard notice={USAGE_LIMIT} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('retry-turn'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
