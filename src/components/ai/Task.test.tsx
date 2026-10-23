// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEP_STATUS_WORDS } from './StepLine';
import { Task, TaskItem, TaskItemFile } from './Task';
import { Tool } from './Tool';

/**
 * Task (M91.9): a titled line that opens onto its steps — the assistant's
 * folded reads, "Read 5 notes" — kept in the document while folded.
 */

afterEach(cleanup);

function Reads({ running = false }: { running?: boolean }) {
  return (
    <Task
      title={running ? 'Reading 2 notes' : 'Read 2 notes'}
      statusText={running ? null : undefined}
      status={running ? 'running' : 'done'}
      icon="file-text"
      data-testid="task"
    >
      <Tool status="done" title="Read notes/a.md" icon="file-text" />
      <Tool status={running ? 'running' : 'done'} title="Read notes/b.md" icon="file-text" />
    </Task>
  );
}

describe('Task', () => {
  it('is titled by the work, and keeps its steps in the document while folded', () => {
    render(<Reads />);
    const trigger = screen.getByRole('button', { name: 'Read 2 notes' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const steps = document.querySelector('[data-slot="task-steps"]') as HTMLElement;
    expect(steps.querySelectorAll('[data-slot="tool"]')).toHaveLength(2);
    expect(steps.closest('[hidden]')).not.toBeNull();
    fireEvent.click(trigger);
    expect(steps.closest('[hidden]')).toBeNull();
    expect(screen.getByTestId('task').dataset.status).toBe('done');
  });

  it('opens while it runs and closes once done, unless the reader chose', () => {
    const { rerender } = render(<Reads running />);
    const trigger = () => screen.getByRole('button', { name: /notes$/ });
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(trigger().textContent).toBe('Reading 2 notes');
    rerender(<Reads />);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger());
    rerender(<Reads running />);
    rerender(<Reads />);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });

  it('says a running task’s state when its title does not', () => {
    render(
      <Task title="2 notes" status="running">
        <TaskItem>Read notes/a.md</TaskItem>
      </Task>,
    );
    expect(screen.getByRole('button', { name: 'Running: 2 notes' })).toBeTruthy();
  });

  it('hears a controlling caller', () => {
    const onOpenChange = vi.fn();
    render(
      <Task title="Read 2 notes" open={false} onOpenChange={onOpenChange}>
        <TaskItem>Read notes/a.md</TaskItem>
      </Task>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Read 2 notes' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Read 2 notes' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });
});

describe('TaskItem and TaskItemFile', () => {
  it('draws a step as a line, its state in words', () => {
    render(
      <>
        <TaskItem status="failed">
          Failed to read <TaskItemFile>notes/c.md</TaskItemFile>
        </TaskItem>
        <TaskItem status="waiting">Read notes/d.md</TaskItem>
      </>,
    );
    const items = document.querySelectorAll('[data-slot="task-item"]');
    // The title's own words say it failed; they are not said twice.
    expect(items[0].querySelector('[data-slot="trace-line"]')?.textContent).toBe(
      'Failed to read notes/c.md',
    );
    expect(items[1].querySelector('[data-slot="trace-line"]')?.textContent).toBe(
      `${STEP_STATUS_WORDS.waiting}: Read notes/d.md`,
    );
    const file = document.querySelector('[data-slot="task-item-file"]') as HTMLElement;
    expect(file.className).toContain('cb-ai-mono');
    expect(file.dataset.variant).toBe('outline');
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });
});
