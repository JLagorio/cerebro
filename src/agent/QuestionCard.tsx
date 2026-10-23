import { Confirmation } from '@/components/ai/Confirmation';
import { Questionnaire } from '@/components/ai/Questionnaire';
import { answerable, cardStatus, denyAnswer, familyTitle } from '@/agent/elements/cards';
import type { WaitingCard } from '@/agent/useAgentChat';
import type { PersonAnswer } from '@/agent/types';

/**
 * The agent's questions (M57.3): AskUserQuestion, drawn in the slot M57.1's
 * card holds as a Confirmation whose body is a Questionnaire (M91.12b). Every
 * question is on the one card — Rust refuses a partial answer set, so there
 * is no Skip, Previous or Next, and no letter or number answers — each a
 * fieldset of radios (one answer) or checkboxes (any number), with Other and
 * its text box. Send answers waits until every question has one
 * (`questionForm.problems`), and Don't answer declines, with words the agent
 * reads if the person gives any. Rust's book holds the call and checks the
 * answers again; this card is only a view of it. The questions, options and
 * previews are the agent's, so they show as text, never as markup, and a
 * preview stays folded until asked for.
 */

/** The card's words (Appendix C, M57.3); the questions' own words (Other,
 * its placeholder, Preview, the decline reason) are the Questionnaire's. */
export const QUESTION_COPY = {
  title: 'A question for you',
  send: 'Send answers',
  decline: 'Don’t answer',
} as const;

interface Props {
  interaction: WaitingCard;
  onAnswer: (answer: PersonAnswer) => void;
}

export function QuestionCard({ interaction, onAnswer }: Props) {
  const { card, stale } = interaction;
  const status = cardStatus(interaction);
  return (
    <Confirmation
      data-testid="question-card"
      data-tool={card.tool_name}
      {...status}
      icon="message-circle-question-mark"
      title={familyTitle(card.family, QUESTION_COPY.title)}
      notice={stale}
      testIds={{ notice: 'interaction-stale' }}
    >
      <Questionnaire
        // The drafts are the Questionnaire's: one set of them per call.
        key={card.id}
        questions={card.questions ?? []}
        disabled={!answerable(status.state)}
        submitLabel={QUESTION_COPY.send}
        declineLabel={QUESTION_COPY.decline}
        onSubmit={(answers) => onAnswer({ kind: 'answers', answers })}
        onDecline={(message) => onAnswer(denyAnswer(message))}
      />
    </Confirmation>
  );
}
