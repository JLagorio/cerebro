// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TodoItem } from '@/engine/ai/types';
import { PLAN_WORDS, Plan, PlanStep, planProgress } from './Plan';

/**
 * Plan (M91.9): the agent's todo list as the turn's plan — "Plan", "N of M
 * done" — whose steps say their status in words (§3.3), the step under way
 * reading what the agent is doing only while the run is live.
 */

afterEach(cleanup);

const TODOS: TodoItem[] = [
  {
    content: 'Read the release notes',
    status: 'completed',
    activeForm: 'Reading the release notes',
  },
  { content: 'Draft the summary', status: 'in_progress', activeForm: 'Drafting the summary' },
  { content: 'Send it to the team', status: 'pending', activeForm: 'Sending it to the team' },
];

/** What a screen reader reads of an element: its text, less what is hidden. */
function spoken(element: Element): string {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

const steps = () => [
  ...document.querySelectorAll<HTMLElement>('[data-slot="plan-steps"] > [data-slot="trace-line"]'),
];

describe('Plan', () => {
  it('is titled "Plan" and counts what is done', () => {
    render(<Plan todos={TODOS} />);
    const trigger = screen.getByRole('button', { name: 'Plan 1 of 3 done' });
    expect(trigger.closest('[data-slot="plan"]')).not.toBeNull();
    expect(planProgress(TODOS)).toBe('1 of 3 done');
  });

  it('says every step’s status in words, its title what is to be done', () => {
    render(<Plan todos={TODOS} defaultOpen />);
    expect(steps().map(spoken)).toEqual([
      'Done: Read the release notes',
      'In progress: Draft the summary',
      'To do: Send it to the team',
    ]);
    expect(steps().map((line) => line.dataset.status ?? null)).toEqual([null, null, 'pending']);
    expect(document.querySelector('.cb-ai-shimmer')).toBeNull();
  });

  it('while the run works through it: open, in progress, and the step under way lit', () => {
    render(<Plan todos={TODOS} isStreaming />);
    const trigger = screen.getByRole('button', { name: 'In progress: Plan 1 of 3 done' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(spoken(steps()[1])).toBe('In progress: Drafting the summary');
    expect(steps()[1].dataset.status).toBe('running');
    expect(steps()[1].querySelector('.cb-ai-shimmer')).not.toBeNull();
    expect(steps()[2].querySelector('.cb-ai-shimmer')).toBeNull();
  });

  it('closes when the run stops, unless the reader chose', () => {
    const { rerender } = render(<Plan todos={TODOS} isStreaming />);
    const trigger = () => screen.getByRole('button', { name: /Plan 1 of 3 done/ });
    rerender(<Plan todos={TODOS} />);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    // No longer in progress: the run stopped, whatever the list says.
    expect(screen.getByRole('button', { name: 'Plan 1 of 3 done' })).toBe(trigger());
    fireEvent.click(trigger());
    rerender(<Plan todos={TODOS} isStreaming />);
    rerender(<Plan todos={TODOS} />);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('is done working once every step is, though the run goes on', () => {
    const done = TODOS.map((todo) => ({ ...todo, status: 'completed' }));
    render(<Plan todos={done} isStreaming />);
    const trigger = screen.getByRole('button', { name: 'Plan 3 of 3 done' });
    expect(trigger.querySelector('[data-status]')).toBeNull();
  });

  it('is a plain line for a list the agent left empty', () => {
    render(<Plan todos={[]} isStreaming />);
    expect(screen.queryByRole('button')).toBeNull();
    const plan = document.querySelector('[data-slot="plan"]') as HTMLElement;
    expect(plan.querySelector('[data-slot="trace-title"]')?.textContent).toBe(PLAN_WORDS.title);
    expect(plan.querySelector('[data-slot="trace-description"]')?.textContent).toBe(
      PLAN_WORDS.noSteps,
    );
    expect(plan.dataset.status).toBeUndefined();
    expect(plan.querySelector('[data-slot="trace-line"]')?.hasAttribute('data-status')).toBe(false);
  });

  it('takes the caller’s title, description and sentence above the steps', () => {
    render(
      <Plan todos={TODOS} title="Plan: brief the team" description="one step left" defaultOpen>
        <p>Summarize this week’s releases for the team.</p>
      </Plan>,
    );
    expect(screen.getByRole('button', { name: 'Plan: brief the team one step left' })).toBeTruthy();
    const details = document.querySelector('[data-slot="plan-details"]') as HTMLElement;
    expect(details.textContent).toBe('Summarize this week’s releases for the team.');
    expect(
      details.compareDocumentPosition(document.querySelector('[data-slot="plan-steps"]') as Node) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('every line with a status says it in words', () => {
    render(<Plan todos={TODOS} isStreaming />);
    const lines = document.querySelectorAll<HTMLElement>('[data-slot="trace-line"][data-status]');
    expect(lines.length).toBe(3);
    for (const line of lines) {
      expect(spoken(line), line.outerHTML).toMatch(/^(?:In progress|To do|Done): /);
    }
  });
});

describe('PlanStep', () => {
  it('draws a status it does not know in the CLI’s own word', () => {
    render(<PlanStep todo={{ content: 'Wait for CI', status: 'blocked' }} />);
    const line = document.querySelector('[data-slot="trace-line"]') as HTMLElement;
    expect(spoken(line)).toBe('Blocked: Wait for CI');
    expect(line.dataset.todo).toBe('blocked');
    expect(line.querySelector('[data-icon="circle-dashed"]')).not.toBeNull();
  });
});
