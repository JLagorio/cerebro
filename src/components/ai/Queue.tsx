// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import {
  createContext,
  createElement,
  useContext,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Icon } from '@/components/ui/Icon';
import type { TodoItem, TodoStatus } from '@/engine/ai/types';
import type { CollapsibleOpenProps } from './Collapsible';
import { renderPart, type PartProps } from './renderPart';
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from './Trace';
import './trace-results.css';

/**
 * What waits, in order (M91.9, shadcn's Queue): the agent's todo list, split
 * into what is left and what is done, or any list a surface keeps — Up next,
 * review notes, wakes, follow-ups. A queue holds sections; a section is a
 * line that opens onto its items, or a heading over them; an item is a line,
 * with its actions beside it and never inside it.
 *
 * shadcn says a todo's status with its icon alone. Here an item with a status
 * says it in words too (§3.3), read before its title: "To do", "In progress",
 * "Done". Only the item in progress while the run is live carries the working
 * light, so it stops when the agent does. The parts collapse into props, as
 * the trace steps' do; QueueItemImage is not ported, since only the image
 * components draw an `<img>` (CV-61).
 */

/** A todo's status in words, read before its title. */
export const TODO_STATUS_WORDS: Readonly<Record<TodoStatus, string>> = {
  pending: 'To do',
  in_progress: 'In progress',
  completed: 'Done',
};

/** Each status's icon. */
export const TODO_STATUS_ICONS: Readonly<Record<TodoStatus, string>> = {
  pending: 'circle',
  in_progress: 'circle-dot',
  completed: 'circle-check',
};

/** The icon of a status this build does not know. */
export const UNKNOWN_TODO_ICON = 'circle-dashed';

/** A status this build knows, or null for one the CLI wrote that it does not. */
export function todoStatusOf(status: string): TodoStatus | null {
  return status === 'pending' || status === 'in_progress' || status === 'completed' ? status : null;
}

/** A status in words: this build's, or the CLI's own word, made readable
 *  ("in_review" reads "In review"). It is text the agent's run wrote, drawn
 *  as text. */
export function todoStatusWords(status: string): string {
  const known = todoStatusOf(status);
  if (known !== null) return TODO_STATUS_WORDS[known];
  const words = status.replace(/[_-]+/g, ' ').trim();
  return words === '' ? TODO_STATUS_WORDS.pending : words[0].toUpperCase() + words.slice(1);
}

/** What a todo says: what the agent is doing — its `activeForm` — while it
 *  is under way and the run is live, and otherwise what is to be done. A
 *  stopped run is not doing anything, so it never reads in the present tense. */
export function todoTitle(todo: TodoItem, live: boolean): string {
  const doing = todo.activeForm?.trim() ?? '';
  return live && todo.status === 'in_progress' && doing !== '' ? doing : todo.content;
}

/** The run is live: an item in progress is under way now. */
const QueueLive = createContext(false);

/** Attributes for the element a line's sentence is drawn in — a test id, the
 *  whole sentence as a tooltip where the line cuts it short — so the caller
 *  hangs them on the sentence itself rather than on a span inside it. */
export type QueueTitleProps = Omit<ComponentProps<'span'>, 'children'> & {
  'data-testid'?: string;
};

export type QueueProps = ComponentProps<'div'> & {
  /** The run that keeps this queue is live, so its item in progress is under
   *  way now and carries the working light. */
  isStreaming?: boolean;
  /** Draw as this element instead of a div — a section with its own name —
   *  with the queue's classes and slot added to it. */
  render?: ReactElement<PartProps>;
};

/** The queue: its sections, one under another. */
export function Queue({ isStreaming = false, render, className, ...props }: QueueProps) {
  return (
    <QueueLive value={isStreaming}>
      {renderPart('div', render, {
        'data-slot': 'queue',
        ...props,
        className: ['cb-ai-queue', className].filter(Boolean).join(' '),
      })}
    </QueueLive>
  );
}

export interface QueueSectionLabelProps {
  /** What the section holds: "to do", "done", "Up next". */
  label: ReactNode;
  /** How many it holds, said before the label: "2 to do". */
  count?: number;
  icon?: string;
  /** Attributes for the sentence: its count and what it holds. */
  labelProps?: QueueTitleProps;
}

/** A section's line: its icon, its count and what it holds. */
export function QueueSectionLabel({ label, count, icon, labelProps }: QueueSectionLabelProps) {
  return (
    <TraceLine>
      {icon !== undefined && (
        <TraceIcon>
          <Icon name={icon} size={16} />
        </TraceIcon>
      )}
      <TraceTitle {...labelProps}>
        {count === undefined ? (
          label
        ) : (
          <>
            {count} {label}
          </>
        )}
      </TraceTitle>
    </TraceLine>
  );
}

export type QueueSectionProps = Omit<ComponentProps<'div'>, 'title'> &
  CollapsibleOpenProps &
  QueueSectionLabelProps & {
    /** False: a heading over items always shown, not a line that opens. */
    collapsible?: boolean;
    /** Puts the label in a heading of this level, so the section can be
     *  reached by its heading; a collapsible one's trigger sits inside it. */
    headingLevel?: 2 | 3 | 4 | 5 | 6;
    /** Buttons beside the label — Resume, Send — never inside its trigger. */
    actions?: ReactNode;
    /** A test id for a collapsible section's trigger, the button that opens
     *  it. */
    triggerTestId?: string;
  };

/**
 * A section of the queue. It starts open, as shadcn's does, and keeps its
 * items in the document while closed, so each keeps its own state.
 */
export function QueueSection({
  label,
  count,
  icon,
  labelProps,
  collapsible = true,
  headingLevel,
  actions,
  triggerTestId,
  open,
  defaultOpen = true,
  onOpenChange,
  className,
  children,
  ...props
}: QueueSectionProps) {
  const line = (
    <QueueSectionLabel label={label} count={count} icon={icon} labelProps={labelProps} />
  );
  const heading = (node: ReactNode) =>
    headingLevel === undefined
      ? node
      : createElement(`h${headingLevel}`, { className: 'cb-ai-queue-heading' }, node);
  const hasActions = actions !== undefined && actions !== null && actions !== false;
  const head = (labelled: ReactNode) => (
    <div data-slot="queue-section-head" className="cb-ai-queue-section-head">
      {heading(labelled)}
      {hasActions && (
        <div data-slot="queue-section-actions" className="cb-ai-queue-actions">
          {actions}
        </div>
      )}
    </div>
  );
  if (!collapsible) {
    return (
      <div
        data-slot="queue-section"
        {...props}
        className={['cb-ai-queue-section', className].filter(Boolean).join(' ')}
      >
        {head(line)}
        <div data-slot="queue-section-content" className="cb-ai-queue-section-body">
          {children}
        </div>
      </div>
    );
  }
  return (
    <TraceCollapsible
      data-slot="queue-section"
      {...props}
      className={['cb-ai-queue-section', className].filter(Boolean).join(' ')}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      {head(<TraceCollapsibleTrigger data-testid={triggerTestId}>{line}</TraceCollapsibleTrigger>)}
      <TraceCollapsibleContent keepMounted>{children}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/** A section's items, in order: the order is the queue's. */
export function QueueList({ className, ...props }: ComponentProps<'ol'>) {
  return (
    <ol
      data-slot="queue-list"
      {...props}
      className={['cb-ai-queue-list', className].filter(Boolean).join(' ')}
    />
  );
}

export type QueueItemProps = Omit<ComponentProps<'li'>, 'title' | 'children'> & {
  /** The item's sentence: a todo, a held message. */
  title?: ReactNode;
  /** Attributes for the sentence's own element. */
  titleProps?: QueueTitleProps;
  /** A todo's status. An item with one says it in words. */
  status?: TodoStatus;
  /** The status in words: the caller's own, or null for none; left out, the
   *  status's own (`TODO_STATUS_WORDS`). */
  statusText?: string | null;
  /** An icon name; left out, the status's own. */
  icon?: string;
  /** Quieter text after the title: when, how many. */
  description?: ReactNode;
  /** Buttons beside the line — Steer, Run now, Edit, Remove. */
  actions?: ReactNode;
  /** Lines under the line: a note, an editor in place of the title. */
  children?: ReactNode;
};

/** One item, as a list item: its line, its actions beside it, and what its
 *  caller hangs under it. Every other attribute lands on the item. */
export function QueueItem({
  title,
  titleProps,
  status,
  statusText,
  icon,
  description,
  actions,
  children,
  className,
  ...props
}: QueueItemProps) {
  const live = useContext(QueueLive);
  const words =
    statusText !== undefined ? statusText : status === undefined ? null : TODO_STATUS_WORDS[status];
  const glyph = icon ?? (status === undefined ? undefined : TODO_STATUS_ICONS[status]);
  const shown = (node: ReactNode) => node !== undefined && node !== null && node !== false;
  return (
    <li
      data-slot="queue-item"
      data-status={status}
      {...props}
      className={['cb-ai-queue-item', className].filter(Boolean).join(' ')}
    >
      <TraceLine
        status={live && status === 'in_progress' ? 'running' : undefined}
        statusText={words === '' ? null : words}
      >
        {glyph !== undefined && (
          <TraceIcon>
            <Icon name={glyph} size={16} />
          </TraceIcon>
        )}
        {shown(title) && <TraceTitle {...titleProps}>{title}</TraceTitle>}
        {shown(description) && <TraceDescription>{description}</TraceDescription>}
      </TraceLine>
      {shown(actions) && (
        <div data-slot="queue-item-actions" className="cb-ai-queue-actions">
          {actions}
        </div>
      )}
      {shown(children) && (
        <div data-slot="queue-item-detail" className="cb-ai-queue-detail">
          {children}
        </div>
      )}
    </li>
  );
}

/** A quiet button beside an item or a section: give an icon-only one an
 *  `aria-label`. */
export function QueueItemAction({
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'>) {
  return (
    <button
      data-slot="queue-item-action"
      {...props}
      type={type}
      className={['cb-ai-queue-action', className].filter(Boolean).join(' ')}
    />
  );
}

/** One todo as an item: its status in words, the CLI's own word for a status
 *  this build does not know. */
export function TodoQueueItem({ todo }: { todo: TodoItem }) {
  const live = useContext(QueueLive);
  const status = todoStatusOf(todo.status);
  return (
    <QueueItem
      data-todo={todo.status}
      status={status ?? undefined}
      statusText={status === null ? todoStatusWords(todo.status) : undefined}
      icon={status === null ? UNKNOWN_TODO_ICON : undefined}
      title={todoTitle(todo, live)}
    />
  );
}

export type TodoQueueProps = Omit<QueueProps, 'children'> & {
  /** The list the agent's latest readable write left (engine/ai/todos.ts). */
  todos: readonly TodoItem[];
};

/**
 * The agent's todo list as a queue: what is left — to do and in progress —
 * then what is done, each section only when it holds something. An empty
 * list draws nothing; no list at all is the caller's to leave out (CV-05).
 */
export function TodoQueue({ todos, ...props }: TodoQueueProps) {
  if (todos.length === 0) return null;
  const done = (todo: TodoItem) => todo.status === 'completed';
  const left = todos.filter((todo) => !done(todo));
  const finished = todos.filter(done);
  // A list may name one todo twice; its place in the list is its identity.
  const items = (list: readonly TodoItem[]) =>
    list.map((todo, index) => <TodoQueueItem key={`${index}:${todo.content}`} todo={todo} />);
  return (
    <Queue {...props}>
      {left.length > 0 && (
        <QueueSection data-section="todo" label="to do" count={left.length} icon="list-todo">
          <QueueList>{items(left)}</QueueList>
        </QueueSection>
      )}
      {finished.length > 0 && (
        <QueueSection data-section="done" label="done" count={finished.length} icon="list-checks">
          <QueueList>{items(finished)}</QueueList>
        </QueueSection>
      )}
    </Queue>
  );
}
