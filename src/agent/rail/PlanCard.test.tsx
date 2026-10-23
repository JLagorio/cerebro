// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { INPUT_PREVIEW_CHARS, railPlan, type RailPlan } from '@/agent/elements/railPlan';
import type { ChatMessage, ToolCall } from '@/agent/types';
import type { TodoItem } from '@/engine/ai/types';
import { PlanCard, RAIL_PLAN_WORDS } from './PlanCard';

/**
 * The rail's Plan card (M92.17): the conversation's latest list under "n of
 * m done", the dock's rows, lit only while the turn that wrote it works and
 * kept once that turn is done; one quiet line with nothing to show, and the
 * reason in words where it cannot show the list (CV-05).
 */

afterEach(cleanup);

const todo = (content: string, status: string, activeForm?: string): TodoItem =>
  activeForm === undefined ? { content, status } : { content, status, activeForm };

const LIST = [
  todo('Read the open risks', 'completed', 'Reading the open risks'),
  todo('Draft the escalation note', 'in_progress', 'Drafting the escalation note'),
  todo('Link the note from the launch page', 'pending', 'Linking the note'),
];
const LATER = [
  todo('Read the open risks', 'completed'),
  todo('Draft the escalation note', 'completed'),
  todo('Link the note from the launch page', 'in_progress', 'Linking the note'),
];

function write(id: string, todos: TodoItem[], over: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    name: 'TodoWrite',
    input: JSON.stringify({ todos }),
    output: null,
    done: true,
    failed: false,
    ...over,
  };
}

const asked = (id: string): ChatMessage => ({ id, role: 'user', text: 'Plan it', tools: [] });
const reply = (id: string, tools: ToolCall[]): ChatMessage => ({
  id,
  role: 'assistant',
  text: '',
  tools,
});

/** The plan of a conversation whose one reply wrote `todos`. */
const planOf = (todos: TodoItem[]): RailPlan =>
  railPlan([asked('u1'), reply('a1', [write('t1', todos)])]);

function draw(plan: RailPlan, { working = false, folded = false } = {}) {
  return render(<PlanCard plan={plan} working={working} folded={folded} />);
}

const card = () => screen.getByTestId('rail-plan');
/** Each row's status, as the dock's rows mark it, by section. */
const rows = (section: string) =>
  [...card().querySelectorAll(`[data-section="${section}"] [data-todo]`)].map(
    (row) => (row as HTMLElement).dataset.todo,
  );

describe('PlanCard', () => {
  it('draws the latest list under how far it has got, what is left before what is done', () => {
    draw(planOf(LIST));
    expect(card().dataset.state).toBe('ready');
    expect(screen.getByRole('group', { name: 'Plan' })).toBe(card());
    expect(within(card()).getByRole('button', { name: 'Plan 1 of 3 done' })).toBeTruthy();
    expect(rows('todo')).toEqual(['in_progress', 'pending']);
    expect(rows('done')).toEqual(['completed']);
    expect(
      within(card())
        .getAllByRole('heading', { level: 4 })
        .map((h) => h.textContent),
    ).toEqual(['2 to do', '1 done']);
    expect(card().textContent).toContain('Draft the escalation note');
    expect(card().querySelector('[data-status="running"]')).toBeNull();
  });

  it('lights the step under way only while the turn that wrote the list works', () => {
    const { rerender } = draw(planOf(LIST), { working: true });
    const lit = card().querySelector('[data-todo="in_progress"] [data-status="running"]');
    expect(lit?.textContent).toContain('Drafting the escalation note');

    // A list an earlier turn wrote is not what the turn at work is doing.
    const earlier = railPlan([asked('u1'), reply('a1', [write('t1', LIST)]), asked('u2')]);
    rerender(<PlanCard plan={earlier} working folded={false} />);
    expect(card().querySelector('[data-status="running"]')).toBeNull();
    expect(card().textContent).toContain('Draft the escalation note');
  });

  it('keeps the list once its turn is done, unlit', () => {
    const plan = planOf(LIST);
    const { rerender } = draw(plan, { working: true });
    rerender(<PlanCard plan={plan} working={false} folded={false} />);
    expect(card().dataset.state).toBe('ready');
    expect(rows('todo')).toEqual(['in_progress', 'pending']);
    expect(card().querySelector('[data-status="running"]')).toBeNull();
  });

  it('is one quiet line with no list: None, or No steps for an empty one the agent wrote', () => {
    const { rerender } = draw(railPlan([asked('u1'), reply('a1', [])]));
    expect(card().dataset.state).toBe('empty');
    expect(within(card()).getByRole('heading', { level: 3 }).textContent).toBe('PlanNone');
    expect(within(card()).queryByRole('button')).toBeNull();

    rerender(<PlanCard plan={planOf([])} working={false} folded={false} />);
    expect(card().dataset.state).toBe('empty');
    expect(within(card()).getByRole('heading', { level: 3 }).textContent).toBe('PlanNo steps');
  });

  it('says a list the thread kept cut short was not recorded, and shows none of it', () => {
    const dictated = `Draft the escalation note, ${'naming every milestone the slip moves, '.repeat(5)}`;
    const cut = { content: `${dictated.slice(0, INPUT_PREVIEW_CHARS)}…`, status: 'in_progress' };
    draw(
      railPlan([
        asked('u1'),
        reply('a1', [write('t1', [], { input: JSON.stringify({ todos: [cut] }) })]),
      ]),
    );
    expect(card().dataset.state).toBe('not-recorded');
    expect(card().textContent).toContain(RAIL_PLAN_WORDS.notRecorded);
    expect(card().querySelector('[data-todo]')).toBeNull();
    expect(screen.queryByTestId('section-unavailable')).toBeNull();
  });

  it('shows an earlier list in place of a latest one that does not read, and says so, unlit', () => {
    draw(
      railPlan([asked('u1'), reply('a1', [write('t1', LIST), write('t2', [], { input: '[' })])]),
      { working: true },
    );
    expect(card().dataset.state).toBe('partial');
    expect(card().textContent).toContain(RAIL_PLAN_WORDS.earlier);
    expect(within(card()).getByRole('button', { name: 'Plan 1 of 3 done' })).toBeTruthy();
    expect(rows('todo')).toEqual(['in_progress', 'pending']);
    expect(card().querySelector('[data-status="running"]')).toBeNull();
  });

  it('says a read that failed left the plan unavailable, never None', () => {
    draw(railPlan([], { state: 'unavailable', reason: 'unreadable', retentionDays: null }));
    expect(card().dataset.state).toBe('unavailable');
    expect(within(card()).getByTestId('section-unavailable').textContent).toContain(
      RAIL_PLAN_WORDS.unavailable,
    );
    expect(card().textContent).not.toContain(RAIL_PLAN_WORDS.none);
  });

  it('draws nothing while the transcript that could hold the plan is still being read', () => {
    const { container } = draw(railPlan([], { state: 'reading' }));
    expect(container.childElementCount).toBe(0);
  });

  it('draws nothing new while folded, and the latest list as it unfolds', () => {
    const first = planOf(LIST);
    const later = planOf(LATER);
    const { rerender } = draw(first);
    rerender(<PlanCard plan={first} working={false} folded />);
    rerender(<PlanCard plan={later} working folded />);
    expect(within(card()).getByRole('button', { name: 'Plan 1 of 3 done' })).toBeTruthy();
    rerender(<PlanCard plan={later} working={false} folded={false} />);
    expect(within(card()).getByRole('button', { name: 'Plan 2 of 3 done' })).toBeTruthy();
    expect(rows('todo')).toEqual(['in_progress']);
  });

  it('has one control, its fold, a tab stop of its own', () => {
    draw(planOf(LIST));
    const controls = within(card()).getAllByRole('button');
    expect(controls).toHaveLength(1);
    expect(controls[0].tabIndex).toBe(0);
  });
});
