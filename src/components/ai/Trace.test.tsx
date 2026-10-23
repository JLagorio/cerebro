// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Icon } from '@/components/ui/Icon';
import {
  TRACE_STATUS_WORDS,
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
  traceStatusWords,
  type TraceStatus,
} from './Trace';

/**
 * Trace (M91.7). TraceIcon is hidden and colour and the running light say
 * nothing to a screen reader, so a line's status reaches its accessible name
 * as words (§3.3): its own, the caller's, or its title's.
 */

afterEach(cleanup);

const STATUSES: TraceStatus[] = ['running', 'error', 'pending'];

/** A line in a row, the way a tool call draws one. */
function Row({
  status,
  statusText,
  title,
}: {
  status?: TraceStatus;
  statusText?: string | null;
  title: string;
}) {
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={status} statusText={statusText}>
          <TraceIcon>
            <Icon name="terminal" />
          </TraceIcon>
          <TraceTitle>{title}</TraceTitle>
          <TraceDescription>14s</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>pnpm build</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

describe('a line says its status in words', () => {
  it.each(STATUSES)('%s, in its own words when the title does not say it', (status) => {
    render(<Row status={status} title="pnpm build" />);
    const row = screen.getByRole('button', {
      name: `${TRACE_STATUS_WORDS[status]}: pnpm build 14s`,
    });
    expect(row.querySelector('[data-slot="trace-line"]')?.getAttribute('data-status')).toBe(status);
  });

  it('in the caller’s words, which replace its own', () => {
    render(<Row status="pending" statusText="Waiting for your answer" title="Read notes.md" />);
    expect(
      screen.getByRole('button', { name: 'Waiting for your answer: Read notes.md 14s' }),
    ).toBeTruthy();
  });

  it('in its title alone, when the title already says it', () => {
    render(<Row status="running" statusText={null} title="Running pnpm build" />);
    expect(screen.getByRole('button', { name: 'Running pnpm build 14s' })).toBeTruthy();
  });

  it('with words and no status: a finished step', () => {
    render(<Row statusText="Done" title="Write the tests" />);
    expect(screen.getByRole('button', { name: 'Done: Write the tests 14s' })).toBeTruthy();
  });

  it('and says nothing extra for done work', () => {
    render(<Row title="Ran pnpm build" />);
    expect(screen.getByRole('button', { name: 'Ran pnpm build 14s' })).toBeTruthy();
  });

  it('every line with a status has a status word in its accessible name', () => {
    // Its own words, or a title that opens with them.
    const words = new RegExp(`^(?:${Object.values(TRACE_STATUS_WORDS).join('|')})\\b`);
    render(
      <Trace>
        {STATUSES.map((status) => (
          <Row key={status} status={status} title="pnpm build" />
        ))}
        <Row status="running" statusText={null} title="Running pnpm lint" />
        <Row status="error" statusText={null} title="Failed to run pnpm test" />
        <TraceLine status="running">
          <TraceTitle>Thinking</TraceTitle>
        </TraceLine>
      </Trace>,
    );
    const lines = document.querySelectorAll<HTMLElement>('[data-slot="trace-line"][data-status]');
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      const trigger = line.closest('button');
      const name = trigger === null ? (line.textContent ?? '') : trigger.textContent;
      expect(name, line.outerHTML).toMatch(words);
    }
  });

  it('traceStatusWords: own words, the caller’s, or none', () => {
    expect(traceStatusWords('error', undefined)).toBe('Failed');
    expect(traceStatusWords('error', 'Denied')).toBe('Denied');
    expect(traceStatusWords('error', null)).toBeNull();
    expect(traceStatusWords(undefined, undefined)).toBeNull();
    expect(traceStatusWords(undefined, '')).toBeNull();
  });
});

describe('Trace parts', () => {
  it('hides the icon and lights a running title only', () => {
    render(
      <Trace>
        <TraceLine status="running">
          <TraceIcon data-testid="icon">
            <Icon name="loader-circle" />
          </TraceIcon>
          <TraceTitle data-testid="running">Reading 5 notes</TraceTitle>
        </TraceLine>
        <TraceLine status="error">
          <TraceTitle data-testid="failed">Failed to read notes.md</TraceTitle>
        </TraceLine>
        <TraceLine>
          <TraceTitle data-testid="done">Read 5 notes</TraceTitle>
        </TraceLine>
      </Trace>,
    );
    expect(screen.getByTestId('icon').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByTestId('running').classList.contains('cb-ai-shimmer')).toBe(true);
    expect(screen.getByTestId('failed').classList.contains('cb-ai-shimmer')).toBe(false);
    expect(screen.getByTestId('done').classList.contains('cb-ai-shimmer')).toBe(false);
  });

  it('keeps shadcn’s slots and a caller’s classes', () => {
    render(
      <Trace className="max-w-sm" data-testid="trace">
        <TraceLine className="font-mono">
          <TraceTitle>Edited trace.tsx</TraceTitle>
          <TraceDescription className="font-mono">+48 −12</TraceDescription>
        </TraceLine>
      </Trace>,
    );
    const trace = screen.getByTestId('trace');
    expect(trace.dataset.slot).toBe('trace');
    expect(trace.className).toBe('cb-ai-trace max-w-sm');
    expect(trace.querySelector('[data-slot="trace-line"]')?.className).toBe(
      'cb-ai-trace-line font-mono',
    );
    expect(trace.querySelector('[data-slot="trace-description"]')?.textContent).toBe('+48 −12');
  });
});

describe('TraceCollapsible', () => {
  it('starts closed, opens on its trigger, and turns aria-expanded', () => {
    render(<Row title="Ran pnpm build" />);
    const trigger = screen.getByRole('button');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('pnpm build')).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('pnpm build')).toBeTruthy();
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('starts open with defaultOpen, its chevron the trigger’s own', () => {
    render(
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>Ran node --version</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="text-n-900">v24.18.0</TraceCollapsibleContent>
      </TraceCollapsible>,
    );
    const trigger = screen.getByRole('button', { name: 'Ran node --version' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const chevron = trigger.querySelector('.cb-ai-trace-chevron');
    expect(chevron?.getAttribute('aria-hidden')).toBe('true');
    // shadcn's className lands on the inner block, under the panel.
    const inner = screen.getByText('v24.18.0');
    expect(inner.className).toBe('cb-ai-trace-content text-n-900');
    expect(inner.parentElement?.id).toBe(trigger.getAttribute('aria-controls'));
  });

  it('controlled: the reader’s click goes to onOpenChange, and open draws', () => {
    const seen = vi.fn();
    function Streaming({ running }: { running: boolean }) {
      const [open, setOpen] = useState<boolean>();
      return (
        <TraceCollapsible
          open={open ?? running}
          onOpenChange={(next) => {
            seen(next);
            setOpen(next);
          }}
        >
          <TraceCollapsibleTrigger>
            <TraceLine status={running ? 'running' : undefined}>
              <TraceTitle>Thinking</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>The plan has three steps.</TraceCollapsibleContent>
        </TraceCollapsible>
      );
    }
    const { rerender } = render(<Streaming running />);
    expect(screen.getByText('The plan has three steps.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(seen).toHaveBeenCalledWith(false);
    expect(screen.queryByText('The plan has three steps.')).toBeNull();
    // The reader's choice outlives the stream ending.
    rerender(<Streaming running={false} />);
    expect(screen.queryByText('The plan has three steps.')).toBeNull();
  });

  it('keepMounted keeps a closed row’s detail as a hidden node', () => {
    render(
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceTitle>Read 3 notes</TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>
          <Trace>
            <TraceLine>
              <TraceTitle>Read notes.md</TraceTitle>
            </TraceLine>
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>,
    );
    const nested = screen.getByText('Read notes.md');
    const panel = nested.closest('[data-slot="trace-collapsible-content"]') as HTMLElement;
    expect(panel.hidden).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Read 3 notes' }));
    expect(panel.hidden).toBe(false);
    expect(screen.getByText('Read notes.md')).toBe(nested);
  });
});
