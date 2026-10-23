// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBLEM_COPY, type QuestionSet } from '@/engine/questionForm';
import { Questionnaire, QuestionnaireItem, QUESTIONNAIRE_WORDS } from './Questionnaire';

/**
 * Questionnaire (M91.8): every question on one page, Send only once each has
 * an answer — never a partial set — Other in the person's own words, and no
 * Skip, Previous, Next or answer shortcuts.
 */

afterEach(cleanup);

const QUESTIONS: QuestionSet = [
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

const section = (n: number) => screen.getByTestId(`question-${n}`);
const option = (n: number, label: string) =>
  within(section(n))
    .getAllByTestId('question-option')
    .find((input) => input.getAttribute('data-label') === label) as HTMLInputElement;
const send = () => screen.getByTestId('question-send') as HTMLButtonElement;

describe('Questionnaire', () => {
  it('puts every question on one page, as fieldsets of radios or checkboxes', () => {
    render(<Questionnaire questions={QUESTIONS} onSubmit={vi.fn()} onDecline={vi.fn()} />);
    const fieldsets = [...document.querySelectorAll('fieldset')];
    expect(fieldsets.map((fieldset) => fieldset.getAttribute('data-testid'))).toEqual([
      'question-1',
      'question-2',
    ]);
    expect(within(section(1)).getByTestId('question-text').textContent).toBe('Which format?');
    expect(within(section(2)).getByTestId('question-header').textContent).toBe('A header pas…');
    expect(screen.getByRole('group', { name: 'Format Which format?' })).toBe(section(1));
    expect(option(1, 'Markdown').type).toBe('radio');
    expect(option(2, 'Summary').type).toBe('checkbox');
    expect(section(2).dataset.multi).toBe('true');
    expect(within(section(1)).getByText('Headings and lists')).toBeTruthy();
    for (const word of ['Skip', 'Previous', 'Next']) {
      expect(screen.queryByRole('button', { name: word })).toBeNull();
    }
  });

  it('shows a preview as text, folded until asked for', () => {
    render(<Questionnaire questions={QUESTIONS} onSubmit={vi.fn()} />);
    const previews = screen.getAllByTestId('question-preview') as HTMLDetailsElement[];
    expect(previews).toHaveLength(1);
    expect(previews[0].tagName).toBe('DETAILS');
    expect(previews[0].open).toBe(false);
    expect(previews[0].textContent).toContain('<b>bold</b> heading');
    expect(previews[0].querySelector('b')).toBeNull();
  });

  it('says what each question still needs, and Send waits for all of them', () => {
    const onSubmit = vi.fn();
    render(<Questionnaire questions={QUESTIONS} onSubmit={onSubmit} />);
    expect(send().disabled).toBe(true);
    const problem = within(section(1)).getByTestId('question-problem');
    expect(problem.textContent).toBe(PROBLEM_COPY.pickOne);
    expect(section(1).getAttribute('aria-describedby')).toBe(problem.id);
    expect(within(section(2)).getByTestId('question-problem').textContent).toBe(
      PROBLEM_COPY.pickAny,
    );

    fireEvent.click(option(1, 'Plain text'));
    expect(within(section(1)).queryByTestId('question-problem')).toBeNull();
    expect(section(1).hasAttribute('aria-describedby')).toBe(false);
    // Half answered: the press goes nowhere.
    fireEvent.click(send());
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(option(2, 'Risks'));
    fireEvent.click(option(2, 'Summary'));
    expect(send().disabled).toBe(false);
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Which format?', picked: ['Plain text'], other: null },
      { question: 'Which sections?', picked: ['Risks', 'Summary'], other: null },
    ]);
  });

  it('takes Other in the person’s own words, and holds Send until they are typed', () => {
    const onSubmit = vi.fn();
    render(<Questionnaire questions={QUESTIONS} onSubmit={onSubmit} />);
    const first = section(1);
    const words = within(first).getByTestId('question-other-text') as HTMLInputElement;
    expect(words.disabled).toBe(true);
    expect(words.getAttribute('aria-label')).toBe(
      `${QUESTIONNAIRE_WORDS.otherPlaceholder}: Which format?`,
    );
    fireEvent.click(within(first).getByTestId('question-other'));
    expect(words.disabled).toBe(false);
    expect(within(first).getByTestId('question-problem').textContent).toBe(PROBLEM_COPY.typeOther);
    fireEvent.change(words, { target: { value: 'HTML' } });

    const second = section(2);
    fireEvent.click(within(second).getByTestId('question-other'));
    expect(within(second).getByTestId('question-problem').textContent).toBe(PROBLEM_COPY.typeOther);
    fireEvent.change(within(second).getByTestId('question-other-text'), {
      target: { value: 'Costs' },
    });
    fireEvent.click(option(2, 'Next steps'));
    // Enter in a field is not a submit: nothing here is a form.
    fireEvent.keyDown(words, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByTestId('question-1').closest('form')).toBeNull();

    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Which format?', picked: [], other: 'HTML' },
      { question: 'Which sections?', picked: ['Next steps'], other: 'Costs' },
    ]);
  });

  it('unticks a checkbox and Other in a multiple choice', () => {
    render(<Questionnaire questions={QUESTIONS} onSubmit={vi.fn()} />);
    fireEvent.click(option(2, 'Summary'));
    fireEvent.click(option(2, 'Summary'));
    expect(option(2, 'Summary').checked).toBe(false);
    const other = within(section(2)).getByTestId('question-other') as HTMLInputElement;
    fireEvent.click(other);
    expect(other.checked).toBe(true);
    fireEvent.click(other);
    expect(other.checked).toBe(false);
    expect(within(section(2)).getByTestId('question-problem').textContent).toBe(
      PROBLEM_COPY.pickAny,
    );
  });

  it('declines, with the person’s reason or none', () => {
    const onDecline = vi.fn();
    render(<Questionnaire questions={QUESTIONS} onSubmit={vi.fn()} onDecline={onDecline} />);
    const decline = screen.getByRole('button', { name: QUESTIONNAIRE_WORDS.decline });
    expect(decline).toBe(screen.getByTestId('question-decline'));
    fireEvent.click(decline);
    expect(onDecline).toHaveBeenLastCalledWith(null);
    fireEvent.change(screen.getByTestId('question-decline-message'), {
      target: { value: '  pick for me  ' },
    });
    fireEvent.click(decline);
    expect(onDecline).toHaveBeenLastCalledWith('pick for me');
  });

  it('has no Don’t answer without a way to decline', () => {
    render(<Questionnaire questions={QUESTIONS} onSubmit={vi.fn()} />);
    expect(screen.queryByTestId('question-decline')).toBeNull();
    expect(screen.queryByTestId('question-decline-message')).toBeNull();
  });

  it('takes no answer while disabled', () => {
    const onSubmit = vi.fn();
    const onDecline = vi.fn();
    render(
      <Questionnaire questions={QUESTIONS} onSubmit={onSubmit} onDecline={onDecline} disabled />,
    );
    expect(option(1, 'Markdown').disabled).toBe(true);
    expect((screen.getByTestId('question-decline') as HTMLButtonElement).disabled).toBe(true);
    expect(send().disabled).toBe(true);
    fireEvent.click(send());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('answers nothing from a letter or a number: there are no shortcuts', () => {
    render(<Questionnaire questions={QUESTIONS} onSubmit={vi.fn()} />);
    for (const key of ['a', 'b', '1', '2']) {
      fireEvent.keyDown(section(1), { key });
      fireEvent.keyDown(option(1, 'Markdown'), { key });
    }
    expect(
      screen.getAllByTestId('question-option').some((input) => (input as HTMLInputElement).checked),
    ).toBe(false);
  });

  it('draws the caller’s own composition of its questions', () => {
    render(
      <Questionnaire questions={QUESTIONS} onSubmit={vi.fn()} submitLabel="Answer">
        <QuestionnaireItem index={1} />
        <QuestionnaireItem index={5} />
      </Questionnaire>,
    );
    expect(screen.queryByTestId('question-1')).toBeNull();
    expect(screen.getByTestId('question-2')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Answer' })).toBe(send());
  });

  it('sends nothing for an empty set', () => {
    render(<Questionnaire questions={[]} onSubmit={vi.fn()} />);
    expect(send().disabled).toBe(true);
  });
});
