// Ported from shadcn/ui at 25af02b, MIT, Copyright (c) 2023 shadcn; see THIRD_PARTY_NOTICES.md.
import { createContext, useContext, useId, useState, type ComponentProps } from 'react';
import { Button } from '@/components/ui/Button';
import {
  initialDrafts,
  OTHER_CHARS,
  problems,
  toAnswers,
  type Draft,
  type Question,
  type QuestionAnswer,
  type QuestionSet,
} from '@/engine/questionForm';
import './conversation.css';

/**
 * The agent's questions, answered on one page (M91.8, shadcn's
 * Questionnaire). shadcn steps through one question at a time with Skip,
 * Previous and Next and letter or number shortcuts; Rust refuses a partial
 * answer set, so here every question is on the page at once and none of
 * that is offered — a deliberate deviation. Each question is a fieldset:
 * its options as native radios (one answer) or checkboxes (any), each with
 * its description and a folded preview, Other with its own words, and the
 * line saying what it still needs. Send waits until every question has an
 * answer (`questionForm.problems`), and never sends a partial set.
 *
 * Questions, options and previews are the agent's words: drawn as text,
 * never as markup. The drafts live here, so key a Questionnaire by its
 * question set. It keeps the `question-*` test hooks the question card's
 * specs read.
 */

/** The Questionnaire's words, unless the caller says better. */
export const QUESTIONNAIRE_WORDS = {
  submit: 'Send answers',
  decline: 'Don’t answer',
  other: 'Other',
  otherPlaceholder: 'Type your answer',
  declinePlaceholder: 'Tell the agent why (optional)',
  preview: 'Preview',
} as const;

/** How much of a header the chip shows. */
const HEADER_CHARS = 12;

/** The most the reason for declining may hold. */
const DECLINE_CHARS = 2000;

function clip(text: string): string {
  const chars = [...text];
  return chars.length <= HEADER_CHARS ? text : `${chars.slice(0, HEADER_CHARS).join('')}…`;
}

interface QuestionnaireState {
  questions: QuestionSet;
  drafts: Draft[];
  problems: (string | null)[];
  disabled: boolean;
  /** Names the radio groups, one per question. */
  name: string;
  setDraft: (at: number, draft: Draft) => void;
}

const QuestionnaireContext = createContext<QuestionnaireState | null>(null);

function useQuestionnaire(part: string): QuestionnaireState {
  const state = useContext(QuestionnaireContext);
  if (state === null) throw new Error(`${part} must sit inside a Questionnaire`);
  return state;
}

export type QuestionnaireProps = Omit<ComponentProps<'div'>, 'onSubmit'> & {
  questions: QuestionSet;
  /** Hears one answer per question, in the set's order — only once every
   *  question has one. */
  onSubmit: (answers: QuestionAnswer[]) => void;
  /** Declines to answer, with the person's reason or null. Without it there
   *  is no Don't answer. */
  onDecline?: (message: string | null) => void;
  /** Nothing can be picked or sent: an answer is on its way, or too late. */
  disabled?: boolean;
  submitLabel?: string;
  declineLabel?: string;
};

/**
 * Every question, the reason field and the actions. Children, when given,
 * replace the questions' own drawing (QuestionnaireItem per question) and
 * sit above the reason field and the actions.
 */
export function Questionnaire({
  questions,
  onSubmit,
  onDecline,
  disabled = false,
  submitLabel = QUESTIONNAIRE_WORDS.submit,
  declineLabel = QUESTIONNAIRE_WORDS.decline,
  className,
  children,
  ...props
}: QuestionnaireProps) {
  const name = useId();
  const [drafts, setDrafts] = useState<Draft[]>(() => initialDrafts(questions));
  const [reason, setReason] = useState('');
  const pending = problems(questions, drafts);
  const ready = questions.length > 0 && pending.every((problem) => problem === null);
  const state: QuestionnaireState = {
    questions,
    drafts,
    problems: pending,
    disabled,
    name,
    setDraft: (at, draft) => setDrafts((held) => held.map((one, i) => (i === at ? draft : one))),
  };

  const submit = () => {
    // The button waits on `ready` too; this is the rule, not the button.
    if (disabled || !ready) return;
    onSubmit(toAnswers(questions, drafts));
  };

  return (
    <QuestionnaireContext value={state}>
      <div
        data-slot="questionnaire"
        {...props}
        data-ready={ready ? '' : undefined}
        className={['cb-ai-questionnaire', className].filter(Boolean).join(' ')}
      >
        {children ??
          questions.map((question, at) => (
            // Rust refuses a set where two questions read alike.
            <QuestionnaireItem key={question.question} index={at} />
          ))}
        {onDecline !== undefined && (
          <input
            type="text"
            data-testid="question-decline-message"
            value={reason}
            disabled={disabled}
            maxLength={DECLINE_CHARS}
            placeholder={QUESTIONNAIRE_WORDS.declinePlaceholder}
            aria-label={QUESTIONNAIRE_WORDS.declinePlaceholder}
            onChange={(event) => setReason(event.target.value)}
            className="cb-ai-questionnaire-input"
          />
        )}
        <div data-slot="questionnaire-actions" className="cb-ai-questionnaire-actions">
          <Button
            variant="primary"
            size="sm"
            testId="question-send"
            disabled={disabled || !ready}
            onClick={submit}
          >
            {submitLabel}
          </Button>
          {onDecline !== undefined && (
            <Button
              variant="secondary"
              size="sm"
              testId="question-decline"
              disabled={disabled}
              onClick={() => onDecline(reason.trim() === '' ? null : reason.trim())}
            >
              {declineLabel}
            </Button>
          )}
        </div>
      </div>
    </QuestionnaireContext>
  );
}

export interface QuestionnaireItemProps {
  /** Which question of the set, from 0. */
  index: number;
  className?: string;
}

/**
 * One question: a fieldset whose legend is its header chip and its text,
 * its options, Other, and the line saying what it still needs, which the
 * fieldset is described by.
 */
export function QuestionnaireItem({ index, className }: QuestionnaireItemProps) {
  const state = useQuestionnaire('QuestionnaireItem');
  const question = state.questions[index];
  const draft = state.drafts[index];
  const id = useId();
  if (question === undefined || draft === undefined) return null;
  const problem = state.problems[index] ?? null;
  return (
    <fieldset
      data-slot="questionnaire-item"
      data-testid={`question-${index + 1}`}
      data-multi={question.multiSelect ? 'true' : 'false'}
      aria-describedby={problem === null ? undefined : `${id}-problem`}
      className={['cb-ai-questionnaire-item', className].filter(Boolean).join(' ')}
    >
      <QuestionnaireTitle question={question} />
      <QuestionnaireChoices
        question={question}
        draft={draft}
        name={`${state.name}-${index}`}
        disabled={state.disabled}
        onDraft={(next) => state.setDraft(index, next)}
      />
      {problem !== null && (
        <QuestionnaireError id={`${id}-problem`} data-testid="question-problem">
          {problem}
        </QuestionnaireError>
      )}
    </fieldset>
  );
}

/** The question's legend: its header as a chip, clipped, and its text. */
export function QuestionnaireTitle({ question }: { question: Question }) {
  return (
    <legend data-slot="questionnaire-title" className="cb-ai-questionnaire-title">
      {question.header !== '' && (
        <span
          data-testid="question-header"
          title={question.header}
          className="cb-ai-questionnaire-header"
        >
          {clip(question.header)}
        </span>
      )}
      <span data-testid="question-text" className="cb-ai-questionnaire-question">
        {question.question}
      </span>
    </legend>
  );
}

interface QuestionnaireChoicesProps {
  question: Question;
  draft: Draft;
  /** The radio group's form name. */
  name: string;
  disabled: boolean;
  onDraft: (draft: Draft) => void;
}

/** The options, then Other and its words. */
export function QuestionnaireChoices({
  question,
  draft,
  name,
  disabled,
  onDraft,
}: QuestionnaireChoicesProps) {
  const multi = draft.kind === 'multi';
  const picked = (label: string) =>
    draft.kind === 'multi'
      ? draft.picked.includes(label)
      : draft.pick.kind === 'option' && draft.pick.label === label;
  const otherChosen = draft.kind === 'multi' ? draft.other !== null : draft.pick.kind === 'other';
  const otherText =
    draft.kind === 'multi'
      ? (draft.other ?? '')
      : draft.pick.kind === 'other'
        ? draft.pick.text
        : '';

  const toggle = (label: string) => {
    if (draft.kind === 'single') {
      onDraft({ kind: 'single', pick: { kind: 'option', label } });
      return;
    }
    onDraft({
      ...draft,
      picked: draft.picked.includes(label)
        ? draft.picked.filter((held) => held !== label)
        : [...draft.picked, label],
    });
  };
  const toggleOther = () => {
    if (draft.kind === 'single') {
      onDraft({ kind: 'single', pick: { kind: 'other', text: otherText } });
      return;
    }
    onDraft({ ...draft, other: draft.other === null ? '' : null });
  };
  const typeOther = (text: string) =>
    onDraft(
      draft.kind === 'single'
        ? { kind: 'single', pick: { kind: 'other', text } }
        : { ...draft, other: text },
    );

  return (
    <div data-slot="questionnaire-choices" className="cb-ai-questionnaire-choices">
      {question.options.map((option) => (
        <div key={option.label} className="cb-ai-questionnaire-option">
          <QuestionnaireChoice
            type={multi ? 'checkbox' : 'radio'}
            name={name}
            label={option.label}
            description={option.description}
            checked={picked(option.label)}
            disabled={disabled}
            onChange={() => toggle(option.label)}
            data-testid="question-option"
            data-label={option.label}
          />
          {option.preview !== null && (
            <details data-testid="question-preview" className="cb-ai-questionnaire-preview">
              <summary>{QUESTIONNAIRE_WORDS.preview}</summary>
              <pre>{option.preview}</pre>
            </details>
          )}
        </div>
      ))}
      <QuestionnaireChoice
        type={multi ? 'checkbox' : 'radio'}
        name={name}
        label={QUESTIONNAIRE_WORDS.other}
        checked={otherChosen}
        disabled={disabled}
        onChange={toggleOther}
        data-testid="question-other"
      />
      <QuestionnaireInput
        data-testid="question-other-text"
        value={otherText}
        disabled={disabled || !otherChosen}
        maxLength={OTHER_CHARS}
        placeholder={QUESTIONNAIRE_WORDS.otherPlaceholder}
        aria-label={`${QUESTIONNAIRE_WORDS.otherPlaceholder}: ${question.question}`}
        onChange={(event) => typeOther(event.target.value)}
      />
    </div>
  );
}

export type QuestionnaireChoiceProps = Omit<ComponentProps<'input'>, 'type'> & {
  type: 'radio' | 'checkbox';
  label: string;
  description?: string;
};

/** One answer: a label holding its native radio or checkbox, its words and
 *  its description. Props other than these go to the input. */
export function QuestionnaireChoice({
  type,
  label,
  description,
  className,
  ...input
}: QuestionnaireChoiceProps) {
  return (
    <label
      data-slot="questionnaire-choice"
      data-type={type}
      className={['cb-ai-questionnaire-choice', className].filter(Boolean).join(' ')}
    >
      <input type={type} {...input} />
      <span className="cb-ai-questionnaire-choice-text">
        <span className="cb-ai-questionnaire-choice-label">{label}</span>
        {description !== undefined && description !== '' && (
          <span className="cb-ai-questionnaire-choice-description">{description}</span>
        )}
      </span>
    </label>
  );
}

/** A free answer in the person's own words. Give it a name: a placeholder
 *  is not one. */
export function QuestionnaireInput({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type="text"
      data-slot="questionnaire-input"
      {...props}
      className={['cb-ai-questionnaire-input', className].filter(Boolean).join(' ')}
    />
  );
}

/** What a question still needs before Send. */
export function QuestionnaireError({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="questionnaire-error"
      {...props}
      className={['cb-ai-questionnaire-error', className].filter(Boolean).join(' ')}
    />
  );
}
