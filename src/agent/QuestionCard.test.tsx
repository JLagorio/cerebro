// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUESTION_COPY, QuestionCard } from '@/agent/QuestionCard';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { Question } from '@/engine/questionForm';

/**
 * The agent's questions (M57.3), drawn as a Confirmation whose body is a
 * Questionnaire (M91.12b): every question on the one card, radios for one
 * answer, checkboxes for any, Other with its own words, Send only once every
 * question has an answer, and Don't answer — by pointer and by keyboard, with
 * no Skip, Previous, Next or answer shortcuts. Whatever the agent wrote shows
 * as text.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
const picked = () =>
  screen
    .getAllByTestId('question-option')
    .filter((input) => (input as HTMLInputElement).checked)
    .map((input) => input.getAttribute('data-label'));

/** The keydown listeners added to window and document while `run` runs. */
function keydownsDuring(run: () => void): number {
  const onWindow = vi.spyOn(window, 'addEventListener');
  const onDocument = vi.spyOn(document, 'addEventListener');
  try {
    run();
    return [...onWindow.mock.calls, ...onDocument.mock.calls].filter(([type]) => type === 'keydown')
      .length;
  } finally {
    onWindow.mockRestore();
    onDocument.mockRestore();
  }
}

describe('QuestionCard', () => {
  it('draws radios for one answer and checkboxes for any, under the table’s title', () => {
    render(<QuestionCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByTestId('question-card');
    expect(card.textContent).toContain(QUESTION_COPY.title);
    expect(card.getAttribute('data-tool')).toBe('AskUserQuestion');
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

  it('is a Confirmation holding every question on one page, with no steps', () => {
    render(<QuestionCard interaction={waiting()} onAnswer={vi.fn()} />);
    const card = screen.getByRole('group', { name: QUESTION_COPY.title });
    expect(card).toBe(screen.getByTestId('question-card'));
    expect(card.dataset.slot).toBe('confirmation');
    expect(card.dataset.state).toBe('waiting');
    expect(
      card.querySelector('[data-icon="message-circle-question-mark"]')?.getAttribute('aria-hidden'),
    ).toBe('true');
    // Each question a fieldset its legend names, all of them at once.
    expect(
      [...card.querySelectorAll('fieldset')].map((set) => set.getAttribute('data-testid')),
    ).toEqual(['question-1', 'question-2']);
    expect(screen.getByRole('group', { name: 'Format Which format?' })).toBe(section(1));
    expect(section(2).getAttribute('data-multi')).toBe('true');
    // The Questionnaire answers: the card adds no answers row of its own.
    expect(card.querySelector('[data-slot="confirmation-answers"]')).toBeNull();
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      QUESTION_COPY.send,
      QUESTION_COPY.decline,
    ]);
    for (const word of ['Skip', 'Previous', 'Next']) {
      expect(screen.queryByRole('button', { name: word })).toBeNull();
    }
    expect(card.closest('form')).toBeNull();
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
    fireEvent.click(send());
    expect(onAnswer).not.toHaveBeenCalled();
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

  it('answers from the keyboard, and no letter or number picks an option', async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    render(<QuestionCard interaction={waiting()} onAnswer={onAnswer} />);
    /** Tab forward to `target`, a stop at a time, as a person would. */
    const tabTo = async (target: HTMLElement) => {
      for (let stop = 0; stop < 12 && document.activeElement !== target; stop += 1) {
        await user.tab();
      }
      expect(document.activeElement).toBe(target);
    };
    await user.tab();
    expect(document.activeElement).toBe(option(1, 'Markdown'));
    await user.keyboard('ab12');
    expect(picked()).toEqual([]);
    await user.keyboard(' ');
    expect(picked()).toEqual(['Markdown']);
    // Send waits for the second question, so it is no stop yet.
    expect(send().disabled).toBe(true);
    await tabTo(option(2, 'Risks'));
    await user.keyboard('3');
    expect(picked()).toEqual(['Markdown']);
    await user.keyboard(' ');
    expect(picked()).toEqual(['Markdown', 'Risks']);
    // Enter in a field is not a submit: nothing here is a form.
    const reason = screen.getByTestId('question-decline-message');
    await tabTo(reason);
    await user.keyboard('{Enter}');
    expect(onAnswer).not.toHaveBeenCalled();
    await tabTo(send());
    await user.keyboard('{Enter}');
    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'answers',
      answers: [
        { question: 'Which format?', picked: ['Markdown'], other: null },
        { question: 'Which sections?', picked: ['Risks'], other: null },
      ],
    });
  });

  it('adds no window or document keydown listener, drawn and answered', () => {
    const added = keydownsDuring(() => {
      render(<QuestionCard interaction={waiting()} onAnswer={vi.fn()} />);
      fireEvent.keyDown(option(1, 'Markdown'), { key: 'a' });
      fireEvent.click(option(1, 'Markdown'));
      fireEvent.click(within(section(2)).getByTestId('question-other'));
      const words = within(section(2)).getByTestId('question-other-text');
      fireEvent.change(words, { target: { value: 'Costs' } });
      fireEvent.keyDown(words, { key: 'Enter' });
      fireEvent.click(send());
    });
    expect(added).toBe(0);
  });

  it('takes no answer while one is on its way or after it came too late', () => {
    const onAnswer = vi.fn();
    const { unmount } = render(
      <QuestionCard interaction={waiting({ answering: true })} onAnswer={onAnswer} />,
    );
    const answering = screen.getByTestId('question-card');
    expect(answering.getAttribute('data-state')).toBe('answering');
    expect(answering.getAttribute('aria-busy')).toBe('true');
    expect((screen.getByTestId('question-decline') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('question-decline-message') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(option(1, 'Markdown').disabled).toBe(true);
    expect(screen.queryByTestId('interaction-stale')).toBeNull();
    unmount();
    const stale = 'No longer waiting: this request was already answered or cancelled.';
    render(<QuestionCard interaction={waiting({ stale })} onAnswer={onAnswer} />);
    expect(screen.getByTestId('question-card').getAttribute('data-state')).toBe('stale');
    expect(screen.getByTestId('interaction-stale').textContent).toBe(stale);
    expect(send().disabled).toBe(true);
    expect(option(2, 'Summary').disabled).toBe(true);
    fireEvent.click(screen.getByTestId('question-decline'));
    expect(onAnswer).not.toHaveBeenCalled();
  });

  it('keeps the person’s picks while an answer comes and goes', () => {
    const { rerender } = render(<QuestionCard interaction={waiting()} onAnswer={vi.fn()} />);
    fireEvent.click(option(1, 'Plain text'));
    fireEvent.click(option(2, 'Summary'));
    rerender(<QuestionCard interaction={waiting({ answering: true })} onAnswer={vi.fn()} />);
    rerender(<QuestionCard interaction={waiting()} onAnswer={vi.fn()} />);
    expect(picked()).toEqual(['Plain text', 'Summary']);
    expect(send().disabled).toBe(false);
  });

  it('sends nothing for a card that holds no questions', () => {
    render(
      <QuestionCard
        interaction={waiting({ card: { ...waiting().card, questions: null } })}
        onAnswer={vi.fn()}
      />,
    );
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(send().disabled).toBe(true);
    expect((screen.getByTestId('question-decline') as HTMLButtonElement).disabled).toBe(false);
  });
});
