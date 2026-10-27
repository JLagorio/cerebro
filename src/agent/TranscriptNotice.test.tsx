// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TranscriptNotice } from '@/agent/TranscriptNotice';

afterEach(cleanup);

const COPY = "What you see is Cerebro's copy.";

function notice() {
  return screen.getByTestId('transcript-unavailable');
}

describe('TranscriptNotice (M56.3)', () => {
  it('words a sweep with the retention in force', () => {
    render(<TranscriptNotice reason="expired" retentionDays={14} cached={false} />);
    expect(notice().getAttribute('data-reason')).toBe('expired');
    expect(notice().textContent).toContain('Cleared by Claude Code');
    expect(notice().textContent).toContain(
      "Claude Code keeps a conversation's transcript for 14 days after its last turn.",
    );
    expect(notice().textContent).not.toContain(COPY);
  });

  it('explains that a quota-trimmed cache has missing earlier content', () => {
    render(<TranscriptNotice reason="cache_trimmed" retentionDays={null} cached />);
    expect(notice().textContent).toContain('Earlier messages unavailable');
    expect(notice().textContent).toContain('browser storage');
    expect(notice().textContent).toContain(COPY);
  });

  it('words a clear without naming a period', () => {
    render(<TranscriptNotice reason="cleared" retentionDays={30} cached={false} />);
    expect(notice().getAttribute('data-reason')).toBe('cleared');
    expect(notice().textContent).toContain("No longer in Claude Code's folder");
    expect(notice().textContent).toContain(
      "This conversation's transcript is gone from Claude Code's folder for this vault, emptied from Settings or removed by hand.",
    );
    expect(notice().textContent).not.toContain('30');
  });

  it('says nothing was recorded, and why a read failed', () => {
    const { unmount } = render(
      <TranscriptNotice reason="not_recorded" retentionDays={30} cached={false} />,
    );
    expect(notice().textContent).toContain('No transcript recorded');
    unmount();
    render(
      <TranscriptNotice
        reason="unreadable"
        retentionDays={30}
        detail="Permission denied (os error 13)"
        cached={false}
      />,
    );
    expect(notice().textContent).toContain("Couldn't read the transcript");
    expect(notice().textContent).toContain('Permission denied (os error 13)');
  });

  it('still says something true about a reason this build does not name', () => {
    render(<TranscriptNotice reason="relocated" retentionDays={null} cached={false} />);
    expect(notice().getAttribute('data-reason')).toBe('relocated');
    expect(notice().textContent).toContain('Transcript unavailable');
  });

  it("names Cerebro's copy only when one is on screen", () => {
    render(<TranscriptNotice reason="cleared" retentionDays={30} cached />);
    expect(notice().textContent).toContain(COPY);
  });

  it('names no period when Claude Code never sweeps', () => {
    render(<TranscriptNotice reason="expired" retentionDays={null} cached={false} />);
    expect(notice().textContent).toContain('Cleared by Claude Code');
    expect(notice().textContent).not.toContain('days');
  });
});
