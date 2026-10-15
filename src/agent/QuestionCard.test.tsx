// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_COPY, QuestionCard } from '@/agent/QuestionCard';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { Question } from '@/engine/questionForm';

/**
 * The agent's questions (M57.3): radios for one answer, checkboxes for any,
 * Other with its own words, Send only once every question has an answer, and
 * Don't answer. Whatever the agent wrote shows as text.
 */

afterEach(cleanup);

const QUESTIONS: Question[] = [
  {
    question: 'Which format?',
    header: 'Format',
    options: [
      { label: 'Markdown', description: 'Headings and lists', preview: '<b>bold</b> heading' },
      { label: 'Plain text', description: '', preview: null },
    ],
    multiSelect: false,
  },
  {
    question: 'Which sections?',
    header: 'A header past twelve',
    options: [
      { label: 'Summary', description: '', preview: null },
      { label: 'Risks', description: '', preview: null },
      { label: 'Next steps', description: '', preview: null },
    ],
    multiSelect: true,
  },
];

const waiting = (over: Partial<WaitingCard> = {}): WaitingCard => ({
  card: {
    id: 'q'.repeat(32),
    kind: 'question',
    tool_name: 'AskUserQuestion',
    tool_id: 't-1',
    session_id: 's-1',
    summary: 'AskUserQuestion',
    family: 'question',
    subject: '{}',
    questions: QUESTIONS,
    input: '{}',
    asked_at: '2026-10-14T12:00:00.000Z',
  },
  messageId: 'm-2',
  answering: false,
  stale: null,
  ...over,
});

const section = (n: number) => screen.getByTestId(`question-${n}`);
const option = (n: number, label: string) =>
  within(section(n))
    .getAllByTestId('question-option')
    .find((el) => el.getAttribute('data-label') === label) as HTMLInputElement;
const send = () => screen.getByTestId('question-send') as HTMLButtonElement;

describe('QuestionCard', () => {
  it('draws radios for one answer and checkboxes for any, under the table’s title', () => {
    render(<QuestionCard interaction={waiting()} onAnswer={vi.fn()} />);
    expect(screen.getByTestId('question-card').textContent).toContain(QUESTION_COPY.title);
    expect(option(1, 'Markdown').type).toBe('radio');
    expect(option(2, 'Risks').type).toBe('checkbox');
    expect(within(section(1)).getByTestId('question-text').textContent).toBe('Which format?');
    expect(section(1).textContent).toContain('Headings and lists');
    // A long header is kept and clipped, in full on hover.
    const chip = within(section(2)).getByTestId('question-header');
    expect(chip.textContent).toBe('A header pas…');
    expect(chip.getAttribute('title')).toBe('A header past twelve');
    expect(screen.getAllByTestId('question-other-text')[0].getAttribute('placeholder')).toBe(
      'Type your answer',
    );
  });

  it('keeps Send disabled until every question has an answer', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard interaction={waiting()} onAnswer={onAnswer} />);
    expect(send().disabled).toBe(true);
    expect(within(section(1)).getByTestId('question-problem').textContent).toBe('Pick one');
    expect(within(section(2)).getByTestId('question-problem').textContent).toBe(
      'Pick at least one',
    );
    fireEvent.click(option(1, 'Markdown'));
    expect(send().disabled).toBe(true);
    fireEvent.click(option(2, 'Summary'));
    fireEvent.click(option(2, 'Risks'));
    expect(send().disabled).toBe(false);
    expect(screen.queryAllByTestId('question-problem')).toHaveLength(0);
    fireEvent.click(send());
    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'answers',
      answers: [
        { question: 'Which format?', picked: ['Markdown'], other: null },
        { question: 'Which sections?', picked: ['Summary', 'Risks'], other: null },
      ],
    });
  });

  it('enables Other’s text box only once Other is chosen, and sends its words', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard interaction={waiting()} onAnswer={onAnswer} />);
    const box = within(section(1)).getByTestId('question-other-text') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    fireEvent.click(within(section(1)).getByTestId('question-other'));
    expect(box.disabled).toBe(false);
    // Other chosen with nothing typed is its own problem.
    expect(within(section(1)).getByTestId('question-problem').textContent).toBe(
      'Type your answer or pick an option',
    );
    fireEvent.change(box, { target: { value: 'HTML' } });
    fireEvent.click(option(2, 'Next steps'));
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'answers',
      answers: [
        { question: 'Which format?', picked: [], other: 'HTML' },
        { question: 'Which sections?', picked: ['Next steps'], other: null },
      ],
    });
  });

  it('sends Don’t answer as a decline, with the person’s words when they give some', () => {
    const onAnswer = vi.fn();
    render(<QuestionCard interaction={waiting()} onAnswer={onAnswer} />);
    const decline = screen.getByTestId('question-decline');
    expect(decline.textContent).toBe('Don’t answer');
    fireEvent.click(decline);
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny' });
    fireEvent.change(screen.getByTestId('question-decline-message'), {
      target: { value: '  pick for me  ' },
    });
    fireEvent.click(decline);
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'deny', message: 'pick for me' });
  });

  it('shows a preview holding markup as text, folded until asked for', () => {
    render(<QuestionCard interaction={waiting()} onAnswer={vi.fn()} />);
    const previews = screen.getAllByTestId('question-preview');
    expect(previews).toHaveLength(1);
    const preview = previews[0] as HTMLDetailsElement;
    expect(preview.tagName).toBe('DETAILS');
    expect(preview.open).toBe(false);
    expect(preview.textContent).toContain('<b>bold</b> heading');
    expect(preview.querySelector('b')).toBeNull();
  });

  it('takes no answer while one is on its way or after it came too late', () => {
    const onAnswer = vi.fn();
    const { unmount } = render(
      <QuestionCard interaction={waiting({ answering: true })} onAnswer={onAnswer} />,
    );
    expect(screen.getByTestId('question-card').getAttribute('data-state')).toBe('answering');
    expect((screen.getByTestId('question-decline') as HTMLButtonElement).disabled).toBe(true);
    expect(option(1, 'Markdown').disabled).toBe(true);
    unmount();
    const stale = 'No longer waiting: this request was already answered or cancelled.';
    render(<QuestionCard interaction={waiting({ stale })} onAnswer={onAnswer} />);
    expect(screen.getByTestId('interaction-stale').textContent).toBe(stale);
    expect(send().disabled).toBe(true);
    expect(onAnswer).not.toHaveBeenCalled();
  });
});
