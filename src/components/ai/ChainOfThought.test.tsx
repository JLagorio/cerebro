// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeSteps } from '@/engine/ai/steps';
import {
  ChainOfThought,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
  chainTitle,
} from './ChainOfThought';
import { Reasoning } from './Reasoning';
import { Task } from './Task';
import { Tool } from './Tool';

/**
 * Chain of Thought (M91.9): a turn's working, folded into one line. The
 * caller puts inside only folded reads and reasoning; this counts what it is
 * told to.
 */

afterEach(cleanup);

/** A turn's chain as the assistant draws one: reasoning and a folded read. */
function Chain({
  running = false,
  failed = 0,
  defaultOpen,
}: {
  running?: boolean;
  failed?: number;
  defaultOpen?: boolean;
}) {
  return (
    <ChainOfThought
      summary={{ running, total: 5, failed }}
      defaultOpen={defaultOpen}
      data-testid="chain"
    >
      <Reasoning text="Find the release notes first." />
      <Task title="Read 2 notes">
        <Tool status="done" title="Read notes/a.md" />
        <Tool status="done" title="Read notes/b.md" />
      </Task>
    </ChainOfThought>
  );
}

const header = () => screen.getByRole('button', { name: /^(Working|5 steps)/ });

describe('ChainOfThought', () => {
  it('says "Working", lit and open, while a step runs', () => {
    render(<Chain running />);
    expect(header().textContent).toBe('Working');
    expect(header().getAttribute('aria-expanded')).toBe('true');
    const title = header().querySelector('[data-slot="trace-title"]') as HTMLElement;
    expect(title.classList.contains('cb-ai-shimmer')).toBe(true);
    expect(screen.getByTestId('chain').dataset.status).toBe('running');
  });

  it('counts its steps once done, and closes unless the reader chose', () => {
    const { rerender } = render(<Chain running />);
    rerender(<Chain />);
    expect(header().textContent).toBe('5 steps');
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByTestId('chain').dataset.status).toBe('done');
  });

  it('says how many failed, and starts open when one did', () => {
    render(<Chain failed={1} />);
    expect(header().textContent).toBe('5 steps, 1 failed');
    expect(header().getAttribute('aria-expanded')).toBe('true');
    const line = header().querySelector('[data-slot="trace-line"]') as HTMLElement;
    expect(line.dataset.status).toBe('error');
  });

  it('opens the latest turn’s chain when the caller says so', () => {
    render(<Chain defaultOpen />);
    expect(header().getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps its steps, and their own open state, while it is closed', () => {
    render(<Chain defaultOpen />);
    fireEvent.click(screen.getByRole('button', { name: 'Read 2 notes' }));
    fireEvent.click(header());
    const reads = screen.getByText('Read 2 notes').closest('[data-slot="task"]') as HTMLElement;
    expect(reads.closest('[hidden]')).not.toBeNull();
    fireEvent.click(header());
    expect(screen.getByRole('button', { name: 'Read 2 notes' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
  });

  it('counts from summarizeSteps', () => {
    const summary = summarizeSteps([
      { kind: 'reasoning', status: 'done', folds: true },
      { kind: 'group', status: 'done', folds: true },
      { kind: 'tool', status: 'failed', folds: false },
    ]);
    expect(chainTitle(summary)).toBe('3 steps, 1 failed');
    expect(chainTitle({ running: false, total: 1, failed: 0 })).toBe('1 step');
    expect(chainTitle({ running: true, total: 4, failed: 2 })).toBe('Working');
  });

  it('says its state in words under a title of the caller’s', () => {
    render(<ChainOfThought summary={{ running: true, total: 2, failed: 0 }} title="Researching" />);
    expect(screen.getByRole('button', { name: 'Running: Researching' })).toBeTruthy();
  });

  it('hears a controlling caller', () => {
    const onOpenChange = vi.fn();
    render(
      <ChainOfThought
        summary={{ running: true, total: 2, failed: 0 }}
        open={false}
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Working' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Working' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });
});

describe('ChainOfThoughtStep and the search results', () => {
  it('draws AI SDK Elements’ steps, a running one in words', () => {
    render(
      <>
        <ChainOfThoughtStep label="Read the build log" description="2s" />
        <ChainOfThoughtStep status="active" label="Searching the web" />
        <ChainOfThoughtStep status="pending" label="Search the code" />
        <ChainOfThoughtSearchResults>
          <ChainOfThoughtSearchResult>nextjs.org</ChainOfThoughtSearchResult>
        </ChainOfThoughtSearchResults>
      </>,
    );
    const lines = [...document.querySelectorAll('[data-slot="trace-line"]')];
    expect(lines.map((line) => [line.getAttribute('data-status'), line.textContent])).toEqual([
      [null, 'Read the build log2s'],
      ['running', 'Running: Searching the web'],
      ['pending', 'Not started: Search the code'],
    ]);
    const result = document.querySelector('[data-slot="chain-of-thought-search-result"]');
    expect(result?.getAttribute('data-variant')).toBe('secondary');
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});
