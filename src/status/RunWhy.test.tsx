// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FleetRunCause } from '@/lib/ipc';
import { RunWhy, runWhyText } from './RunWhy';

/*
 * Why a run started (M56.7). The words come from Rust; these specs pin what
 * this side adds to them — the detail, the lateness — and the two sentences
 * that stand in when there are no words to show.
 */

const schedule: FleetRunCause = {
  kind: 'schedule',
  why: 'its schedule came due',
  subject: null,
  detail: 'weekdays 08:30',
  due_at: '2026-07-28T08:30:00.000Z',
};

describe('RunWhy', () => {
  afterEach(cleanup);

  it('a run with no cause reads "why not recorded", never a blank', () => {
    render(<RunWhy cause={null} startedAt="2026-07-28T04:20:00Z" />);
    const why = screen.getByTestId('run-why');
    expect(why.textContent).toBe('why not recorded');
    expect(why.hasAttribute('data-kind')).toBe(false);
    // A row seeded before the field existed reads the same.
    expect(runWhyText(undefined, '2026-07-28T04:20:00Z')).toBe('why not recorded');
  });

  it('a schedule 45 minutes late says so, after its detail', () => {
    render(<RunWhy cause={schedule} startedAt="2026-07-28T09:15:00Z" />);
    const why = screen.getByTestId('run-why');
    expect(why.textContent).toBe('its schedule came due (weekdays 08:30) · ran 45m late');
    expect(why.getAttribute('data-kind')).toBe('schedule');
    expect(why.getAttribute('title')).toBe(why.textContent);
  });

  it('a run on time shows no lateness', () => {
    expect(runWhyText(schedule, '2026-07-28T08:31:00Z')).toBe(
      'its schedule came due (weekdays 08:30)',
    );
  });

  it('an empty why names the kind in words rather than showing nothing', () => {
    expect(
      runWhyText(
        { kind: 'standup', why: '', subject: null, detail: null, due_at: null },
        '2026-07-28T09:00:00Z',
      ),
    ).toBe('started for a reason this version does not name (standup)');
  });

  it('keeps the subject a hover away', () => {
    render(
      <RunWhy
        cause={{
          kind: 'event',
          why: 'a vault change matched its trigger',
          subject: 'records/risks/r1.md',
          detail: 'a note in records/risks changes',
          due_at: null,
        }}
        startedAt="2026-07-28T09:00:00Z"
      />,
    );
    const why = screen.getByTestId('run-why');
    expect(why.textContent).toBe(
      'a vault change matched its trigger (a note in records/risks changes)',
    );
    expect(why.getAttribute('title')).toContain('records/risks/r1.md');
  });
});
