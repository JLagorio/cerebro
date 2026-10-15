import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { PersonAnswer } from '@/agent/types';
import {
  initialDrafts,
  OTHER_CHARS,
  problems,
  toAnswers,
  type Draft,
  type Question,
} from '@/engine/questionForm';
import { familyCard } from '@/lib/policy/toolApproval';

/**
 * The agent's questions (M57.3): AskUserQuestion, drawn in the slot M57.1's
 * card holds. One section per question, its options as radios (one answer)
 * or checkboxes (any number), each with Other and its text box; Send answers
 * waits until every question has one (`questionForm.problems`), and Don't
 * answer declines, with words the agent reads if the person gives any.
 * Rust's book holds the call and checks the answers again; this card is
 * only a view of it. The questions, options and previews are the agent's,
 * so they show as text, never as markup, and a preview stays folded until
 * asked for.
 */

/** The card's words (Appendix C, M57.3). */
export const QUESTION_COPY = {
  title: 'A question for you',
  send: 'Send answers',
  decline: 'Don’t answer',
  other: 'Other',
  otherPlaceholder: 'Type your answer',
  declinePlaceholder: 'Tell the agent why (optional)',
  preview: 'Preview',
} as const;

/** How much of a header the chip shows. */
const HEADER_CHARS = 12;

function clip(text: string): string {
  const chars = [...text];
  return chars.length <= HEADER_CHARS ? text : `${chars.slice(0, HEADER_CHARS).join('')}…`;
}

interface Props {
  interaction: WaitingCard;
  onAnswer: (answer: PersonAnswer) => void;
}

interface SectionProps {
  question: Question;
  at: number;
  cardId: string;
  draft: Draft;
  problem: string | null;
  disabled: boolean;
  onDraft: (draft: Draft) => void;
}

function QuestionSection({
  question,
  at,
  cardId,
  draft,
  problem,
  disabled,
  onDraft,
}: SectionProps) {
  const multi = draft.kind === 'multi';
  const name = `question-${cardId}-${at}`;
  const isPicked = (label: string) =>
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
  const typeOther = (text: string) => {
    onDraft(
      draft.kind === 'single'
        ? { kind: 'single', pick: { kind: 'other', text } }
        : { ...draft, other: text },
    );
  };

  return (
    <fieldset
      data-testid={`question-${at + 1}`}
      data-multi={multi ? 'true' : 'false'}
      className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0"
    >
      <legend className="flex min-w-0 flex-col gap-0.5 p-0">
        {question.header !== '' && (
          <span
            data-testid="question-header"
            title={question.header}
            className="w-fit rounded-sm bg-cortex-100 px-1 py-px text-2xs font-medium text-cortex-700"
          >
            {clip(question.header)}
          </span>
        )}
        <span data-testid="question-text" className="font-medium text-n-800">
          {question.question}
        </span>
      </legend>
      {question.options.map((option) => (
        <div key={option.label} className="flex flex-col">
          <label className="flex cursor-pointer items-start gap-1.5">
            <input
              data-testid="question-option"
              data-label={option.label}
              type={multi ? 'checkbox' : 'radio'}
              name={name}
              checked={isPicked(option.label)}
              disabled={disabled}
              onChange={() => toggle(option.label)}
              className="mt-0.5"
            />
            <span className="flex min-w-0 flex-col">
              <span className="text-n-800">{option.label}</span>
              {option.description !== '' && (
                <span className="text-2xs text-n-500">{option.description}</span>
              )}
            </span>
          </label>
          {option.preview !== null && (
            <details data-testid="question-preview" className="ml-5">
              <summary className="cursor-pointer text-2xs text-n-500">
                {QUESTION_COPY.preview}
              </summary>
              <pre className="m-0 mt-1 max-h-[160px] overflow-auto whitespace-pre-wrap break-words [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-600">
                {option.preview}
              </pre>
            </details>
          )}
        </div>
      ))}
      <label className="flex cursor-pointer items-center gap-1.5">
        <input
          data-testid="question-other"
          type={multi ? 'checkbox' : 'radio'}
          name={name}
          checked={otherChosen}
          disabled={disabled}
          onChange={toggleOther}
        />
        <span className="text-n-800">{QUESTION_COPY.other}</span>
      </label>
      <input
        data-testid="question-other-text"
        type="text"
        value={otherText}
        disabled={disabled || !otherChosen}
        maxLength={OTHER_CHARS}
        placeholder={QUESTION_COPY.otherPlaceholder}
        aria-label={`${QUESTION_COPY.otherPlaceholder}: ${question.question}`}
        onChange={(e) => typeOther(e.target.value)}
        className="ml-5 rounded-md border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-800 disabled:opacity-60"
      />
      {problem !== null && (
        <div data-testid="question-problem" className="text-2xs text-n-500">
          {problem}
        </div>
      )}
    </fieldset>
  );
}

export function QuestionCard({ interaction, onAnswer }: Props) {
  const { card, answering, stale } = interaction;
  const questions = card.questions ?? [];
  const [drafts, setDrafts] = useState<Draft[]>(() => initialDrafts(questions));
  const [message, setMessage] = useState('');
  const disabled = answering || stale !== null;
  const pending = problems(questions, drafts);
  const ready = questions.length > 0 && pending.every((problem) => problem === null);
  const title =
    (card.family != null ? familyCard(card.family)?.title : null) ?? QUESTION_COPY.title;

  const decline = () => {
    const said = message.trim();
    onAnswer(said === '' ? { kind: 'deny' } : { kind: 'deny', message: said });
  };

  return (
    <div
      data-testid="question-card"
      data-tool={card.tool_name}
      data-state={stale !== null ? 'stale' : answering ? 'answering' : 'waiting'}
      className="flex flex-col gap-2 rounded-lg border border-cortex-200 bg-cortex-50 px-2.5 py-2 text-xs"
    >
      <div className="flex items-center gap-1.5 font-semibold text-n-800">
        <Icon name="message-circle-question-mark" size={12} color="var(--cortex-600)" />
        {title}
      </div>
      {questions.map((question, at) => (
        <QuestionSection
          key={question.question}
          question={question}
          at={at}
          cardId={card.id}
          draft={drafts[at]}
          problem={pending[at]}
          disabled={disabled}
          onDraft={(draft) => setDrafts((held) => held.map((one, i) => (i === at ? draft : one)))}
        />
      ))}
      {stale !== null && (
        <div data-testid="interaction-stale" className="text-2xs text-n-600">
          {stale}
        </div>
      )}
      <input
        data-testid="question-decline-message"
        type="text"
        value={message}
        disabled={disabled}
        maxLength={2000}
        placeholder={QUESTION_COPY.declinePlaceholder}
        aria-label={QUESTION_COPY.declinePlaceholder}
        onChange={(e) => setMessage(e.target.value)}
        className="rounded-md border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-800"
      />
      <div className="flex flex-wrap gap-1.5">
        <Button
          variant="primary"
          size="sm"
          testId="question-send"
          disabled={disabled || !ready}
          onClick={() => onAnswer({ kind: 'answers', answers: toAnswers(questions, drafts) })}
        >
          {QUESTION_COPY.send}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          testId="question-decline"
          disabled={disabled}
          onClick={decline}
        >
          {QUESTION_COPY.decline}
        </Button>
      </div>
    </div>
  );
}
