// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TodoItem } from '@/engine/ai/types';
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueList,
  QueueSection,
  TODO_STATUS_WORDS,
  TodoQueue,
  todoStatusOf,
  todoStatusWords,
  todoTitle,
} from './Queue';

/**
 * Queue (M91.9): the agent's todo list split into what is left and what is
 * done, or any list a surface keeps. An item with a status says it in words
 * (§3.3), and only the item in progress while the run is live is lit.
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

const items = () => [...document.querySelectorAll<HTMLElement>('[data-slot="queue-item"]')];

describe('the todo words', () => {
  it('knows the CLI’s three statuses, and no other', () => {
    expect(todoStatusOf('pending')).toBe('pending');
    expect(todoStatusOf('in_progress')).toBe('in_progress');
    expect(todoStatusOf('completed')).toBe('completed');
    expect(todoStatusOf('in_review')).toBeNull();
  });

  it('says each in words, and an unknown one in the CLI’s own', () => {
    expect(todoStatusWords('pending')).toBe('To do');
    expect(todoStatusWords('in_progress')).toBe('In progress');
    expect(todoStatusWords('completed')).toBe('Done');
    expect(todoStatusWords('in_review')).toBe('In review');
    expect(todoStatusWords('blocked-by-ci')).toBe('Blocked by ci');
    expect(todoStatusWords(' ')).toBe(TODO_STATUS_WORDS.pending);
  });

  it('reads what the agent is doing only while it is doing it', () => {
    const doing = TODOS[1];
    expect(todoTitle(doing, true)).toBe('Drafting the summary');
    expect(todoTitle(doing, false)).toBe('Draft the summary');
    expect(todoTitle(TODOS[2], true)).toBe('Send it to the team');
    expect(todoTitle({ ...doing, activeForm: '  ' }, true)).toBe('Draft the summary');
    expect(todoTitle({ content: 'Ship', status: 'in_progress' }, true)).toBe('Ship');
  });
});

describe('TodoQueue', () => {
  it('splits what is left from what is done, each a section open from the start', () => {
    render(<TodoQueue todos={TODOS} />);
    const left = screen.getByRole('button', { name: '2 to do' });
    const done = screen.getByRole('button', { name: '1 done' });
    expect(left.getAttribute('aria-expanded')).toBe('true');
    expect(done.getAttribute('aria-expanded')).toBe('true');
    const sections = document.querySelectorAll('[data-slot="queue-section"]');
    expect([...sections].map((section) => section.getAttribute('data-section'))).toEqual([
      'todo',
      'done',
    ]);
    expect(within(sections[0] as HTMLElement).getAllByRole('listitem')).toHaveLength(2);
    expect(within(sections[1] as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
  });

  it('says every item’s status in words before its title', () => {
    render(<TodoQueue todos={TODOS} />);
    expect(items().map(spoken)).toEqual([
      'In progress: Draft the summary',
      'To do: Send it to the team',
      'Done: Read the release notes',
    ]);
  });

  it('lights the item in progress, in the present tense, only while the run is live', () => {
    const { rerender } = render(<TodoQueue todos={TODOS} isStreaming />);
    const title = () => items()[0].querySelector('[data-slot="trace-title"]') as HTMLElement | null;
    expect(spoken(items()[0])).toBe('In progress: Drafting the summary');
    expect(title()?.classList.contains('cb-ai-shimmer')).toBe(true);
    expect(items()[1].querySelector('.cb-ai-shimmer')).toBeNull();
    rerender(<TodoQueue todos={TODOS} isStreaming={false} />);
    expect(spoken(items()[0])).toBe('In progress: Draft the summary');
    expect(title()?.classList.contains('cb-ai-shimmer')).toBe(false);
    expect(document.querySelector('[data-status="running"]')).toBeNull();
  });

  it('draws a status it does not know in the CLI’s own word', () => {
    render(<TodoQueue todos={[{ content: 'Wait for review', status: 'in_review' }]} />);
    const [item] = items();
    expect(spoken(item)).toBe('In review: Wait for review');
    expect(item.dataset.todo).toBe('in_review');
    expect(item.querySelector('[data-icon="circle-dashed"]')).not.toBeNull();
  });

  it('draws only the sections that hold something, and nothing for an empty list', () => {
    const { rerender, container } = render(<TodoQueue todos={[TODOS[0]]} />);
    expect(screen.queryByRole('button', { name: /to do/ })).toBeNull();
    expect(screen.getByRole('button', { name: '1 done' })).toBeTruthy();
    rerender(<TodoQueue todos={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('keeps a closed section’s items in the document', () => {
    render(<TodoQueue todos={TODOS} />);
    fireEvent.click(screen.getByRole('button', { name: '2 to do' }));
    expect(screen.getByRole('button', { name: '2 to do' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(items()[0].closest('[hidden]')).not.toBeNull();
  });
});

describe('QueueItem', () => {
  it('takes the caller’s words, or none', () => {
    render(
      <Queue>
        <QueueList>
          <QueueItem title="Steer the release" status="in_progress" statusText="Starting" />
          <QueueItem title="Plain row" status="pending" statusText={null} />
          <QueueItem title="No status" />
        </QueueList>
      </Queue>,
    );
    expect(items().map(spoken)).toEqual(['Starting: Steer the release', 'Plain row', 'No status']);
  });

  it('puts its actions beside its line, never inside a trigger, and its lines under it', () => {
    const remove = vi.fn();
    render(
      <Queue>
        <QueueList>
          <QueueItem
            data-testid="up-next-entry"
            data-id="e1"
            icon="corner-down-right"
            title="Check the build"
            description="2m ago"
            actions={
              <QueueItemAction
                data-testid="up-next-remove"
                aria-label="Remove from Up next"
                onClick={remove}
              >
                x
              </QueueItemAction>
            }
          >
            Waiting for the turn to end.
          </QueueItem>
        </QueueList>
      </Queue>,
    );
    const item = screen.getByTestId('up-next-entry');
    expect(item.tagName).toBe('LI');
    expect(item.dataset.id).toBe('e1');
    const action = screen.getByRole('button', { name: 'Remove from Up next' });
    expect(action.getAttribute('type')).toBe('button');
    expect(action.closest('[data-slot="trace-line"]')).toBeNull();
    expect(action.closest('[data-slot="queue-item-actions"]')?.parentElement).toBe(item);
    fireEvent.click(screen.getByTestId('up-next-remove'));
    expect(remove).toHaveBeenCalledOnce();
    expect(item.querySelector('[data-slot="trace-description"]')?.textContent).toBe('2m ago');
    expect(item.querySelector('[data-slot="queue-item-detail"]')?.textContent).toBe(
      'Waiting for the turn to end.',
    );
  });

  it('hangs the caller’s attributes on its sentence itself, never on a span inside it', () => {
    render(
      <Queue>
        <QueueList>
          <QueueItem
            title="Check the build, then publish the notes"
            titleProps={{ 'data-testid': 'up-next-text', title: 'Check the build, then publish' }}
            status="in_progress"
            statusText="Starting…"
          />
        </QueueList>
      </Queue>,
    );
    const title = screen.getByTestId('up-next-text');
    expect(title.dataset.slot).toBe('trace-title');
    expect(title.getAttribute('title')).toBe('Check the build, then publish');
    expect(title.children).toHaveLength(0);
    expect(title.textContent).toBe('Check the build, then publish the notes');
    // The status is still said before it, in the line around it.
    expect(spoken(items()[0])).toBe('Starting…: Check the build, then publish the notes');
  });
});

describe('QueueSection', () => {
  it('is a line that opens onto its items, with its actions beside the trigger', () => {
    const onOpenChange = vi.fn();
    render(
      <Queue>
        <QueueSection
          label="review notes ready"
          count={3}
          icon="message-square-quote"
          defaultOpen={false}
          onOpenChange={onOpenChange}
          actions={
            <QueueItemAction data-testid="review-notes-send">Send to the agent</QueueItemAction>
          }
        >
          <QueueList>
            <QueueItem title="Tighten the intro" />
          </QueueList>
        </QueueSection>
      </Queue>,
    );
    const trigger = screen.getByRole('button', { name: '3 review notes ready' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const send = screen.getByTestId('review-notes-send');
    expect(trigger.contains(send)).toBe(false);
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByText('Tighten the intro')).toBeTruthy();
  });

  it('is a heading over items always shown when it does not collapse', () => {
    render(
      <Queue render={<section aria-label="Up next" data-testid="up-next" />}>
        <QueueSection label="Up next" collapsible={false} headingLevel={3}>
          <QueueList>
            <QueueItem title="Then publish it" />
          </QueueList>
        </QueueSection>
      </Queue>,
    );
    const root = screen.getByRole('region', { name: 'Up next' });
    expect(root).toBe(screen.getByTestId('up-next'));
    expect(root.dataset.slot).toBe('queue');
    expect(root.classList.contains('cb-ai-queue')).toBe(true);
    expect(screen.getByRole('heading', { level: 3, name: 'Up next' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('list')).toBeTruthy();
  });

  it('names its trigger and its sentence by the caller’s attributes', () => {
    const { rerender } = render(
      <QueueSection
        label="review notes ready"
        count={2}
        triggerTestId="review-notes-toggle"
        labelProps={{ 'data-testid': 'review-notes-count' }}
        defaultOpen={false}
      >
        <QueueList>
          <QueueItem title="Tighten the intro" />
        </QueueList>
      </QueueSection>,
    );
    const trigger = screen.getByTestId('review-notes-toggle');
    expect(trigger).toBe(screen.getByRole('button', { name: '2 review notes ready' }));
    const count = screen.getByTestId('review-notes-count');
    expect(count.dataset.slot).toBe('trace-title');
    expect(count.textContent).toBe('2 review notes ready');
    expect(trigger.contains(count)).toBe(true);
    // A heading has no trigger to name; its sentence keeps its attributes.
    rerender(
      <QueueSection
        label="Up next"
        collapsible={false}
        headingLevel={3}
        triggerTestId="review-notes-toggle"
        labelProps={{ 'data-testid': 'up-next-label' }}
      >
        <QueueList>
          <QueueItem title="Then publish it" />
        </QueueList>
      </QueueSection>,
    );
    expect(screen.queryByTestId('review-notes-toggle')).toBeNull();
    expect(screen.getByTestId('up-next-label').textContent).toBe('Up next');
  });

  it('puts a collapsible section’s trigger in its heading, when asked', () => {
    render(
      <QueueSection label="to do" count={1} headingLevel={4}>
        <QueueList>
          <QueueItem title="One" />
        </QueueList>
      </QueueSection>,
    );
    const heading = screen.getByRole('heading', { level: 4, name: '1 to do' });
    expect(within(heading).getByRole('button', { name: '1 to do' })).toBeTruthy();
  });
});
