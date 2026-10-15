/**
 * AskUserQuestion's questions, as a form the person fills in (M57.3).
 *
 * Claude Code 2.1.250's tool asks 1 to 4 questions, each with a header, 2 to
 * 4 options and `multiSelect`; Other is the person's own words. This module
 * holds the card's drafts (`initialDrafts`, `problems`, `toAnswers`) and the
 * twins of `src-tauri/src/agent/question.rs` the mock backend needs
 * (`parseQuestions`, `answersFor`, `join`): the same rules, refusal for
 * refusal, in the same words, held to Rust by
 * `src-tauri/fixtures/question-answers.json`, which both replay.
 *
 * Pure: no DOM, no store, no React.
 */

/** One option a question offers. `preview` is agent-written text, shown as
 * text and never as markup. */
export interface QuestionOption {
  label: string;
  description: string;
  preview: string | null;
}

/** One question, as Rust's book draws it on a card. */
export interface Question {
  question: string;
  /** Over 12 characters is kept, and the card clips it. */
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export type QuestionSet = Question[];

/** A person's answer to one question, as the answer command carries it. */
export interface QuestionAnswer {
  question: string;
  picked: string[];
  other: string | null;
}

/** The most a person may type under Other, in characters, once cleaned. */
export const OTHER_CHARS = 2000;

/** A single-select question's draft: nothing yet, an option, or Other with
 * its text. Other with no text is not the same as nothing picked. */
export type SingleDraft =
  | { kind: 'single'; pick: { kind: 'none' } }
  | { kind: 'single'; pick: { kind: 'option'; label: string } }
  | { kind: 'single'; pick: { kind: 'other'; text: string } };

/** A multi-select question's draft: the labels picked, in the order picked,
 * and Other's text, null while Other is not chosen. */
export interface MultiDraft {
  kind: 'multi';
  picked: string[];
  other: string | null;
}

export type Draft = SingleDraft | MultiDraft;

/** What the card says while a question cannot be sent yet. */
export const PROBLEM_COPY = {
  pickOne: 'Pick one',
  pickAny: 'Pick at least one',
  typeOther: 'Type your answer or pick an option',
} as const;

/** A fresh draft per question: nothing picked. */
export function initialDrafts(set: QuestionSet): Draft[] {
  return set.map((question) =>
    question.multiSelect
      ? { kind: 'multi', picked: [], other: null }
      : { kind: 'single', pick: { kind: 'none' } },
  );
}

/** Each question's problem, or null when it can be sent: Send waits until
 * every entry is null. */
export function problems(set: QuestionSet, drafts: readonly Draft[]): (string | null)[] {
  return set.map((_, at) => {
    const draft = drafts[at];
    if (draft === undefined) return PROBLEM_COPY.pickOne;
    if (draft.kind === 'single') {
      if (draft.pick.kind === 'none') return PROBLEM_COPY.pickOne;
      if (draft.pick.kind === 'other' && draft.pick.text.trim() === '') {
        return PROBLEM_COPY.typeOther;
      }
      return null;
    }
    if (draft.other !== null && draft.other.trim() === '') return PROBLEM_COPY.typeOther;
    if (draft.picked.length === 0 && draft.other === null) return PROBLEM_COPY.pickAny;
    return null;
  });
}

/** The answers the drafts make, one per question, in the set's order. */
export function toAnswers(set: QuestionSet, drafts: readonly Draft[]): QuestionAnswer[] {
  return set.map((question, at) => {
    const draft = drafts[at];
    const answer = (picked: string[], other: string | null): QuestionAnswer => ({
      question: question.question,
      picked,
      other,
    });
    if (draft === undefined) return answer([], null);
    if (draft.kind === 'multi') return answer([...draft.picked], draft.other);
    switch (draft.pick.kind) {
      case 'none':
        return answer([], null);
      case 'option':
        return answer([draft.pick.label], null);
      case 'other':
        return answer([], draft.pick.text);
    }
  });
}

// --- The twins of question.rs ------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown, key: string): string => {
  const held = isRecord(value) ? value[key] : undefined;
  return typeof held === 'string' ? held : '';
};

const listOf = (value: unknown, key: string): unknown[] => {
  const held = isRecord(value) ? value[key] : undefined;
  return Array.isArray(held) ? held : [];
};

/** Rust's `str::trim` for the text a card handles. */
const blank = (text: string): boolean => text.trim() === '';

export type Parsed<T> = { ok: T } | { refused: string };

/** The questions a call asks, or why a card cannot show them, as
 * question.rs's `parse_questions`. */
export function parseQuestions(input: unknown): Parsed<QuestionSet> {
  const list = listOf(input, 'questions');
  if (list.length < 1 || list.length > 4) {
    return {
      refused: `A question set holds 1 to 4 questions; this one holds ${list.length}.`,
    };
  }
  const set: QuestionSet = [];
  for (const item of list) {
    const text = textOf(item, 'question');
    if (blank(text)) return { refused: 'A question has no text.' };
    if (set.some((q) => q.question === text)) return { refused: `Two questions read "${text}".` };
    const offered = listOf(item, 'options');
    if (offered.length < 2 || offered.length > 4) {
      return {
        refused: `"${text}" offers ${offered.length} options; a question offers 2 to 4.`,
      };
    }
    const options: QuestionOption[] = [];
    for (const option of offered) {
      const label = textOf(option, 'label');
      if (blank(label)) return { refused: `"${text}" offers an option with no label.` };
      if (options.some((o) => o.label === label)) {
        return { refused: `"${text}" offers "${label}" twice.` };
      }
      const preview = isRecord(option) ? option.preview : undefined;
      options.push({
        label,
        description: textOf(option, 'description'),
        preview: typeof preview === 'string' ? preview : null,
      });
    }
    set.push({
      question: text,
      header: textOf(item, 'header'),
      options,
      multiSelect: isRecord(item) && item.multiSelect === true,
    });
  }
  return { ok: set };
}

/** Other's text, cleaned: control characters (C0, DEL, C1) become spaces,
 * and the ends are trimmed. */
function clean(raw: string): string {
  // eslint-disable-next-line no-control-regex -- the control characters ARE the match: they become spaces, as question.rs's clean does.
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
}

/** A multi-select answer's values joined as Claude Code 2.1.250 joins them:
 * a value holding `, ` or a double quote becomes its JSON string. */
export function join(values: readonly string[]): string {
  return values
    .map((value) => (value.includes(', ') || value.includes('"') ? JSON.stringify(value) : value))
    .join(', ');
}

/** The `answers` map for `set`, in its order, or why it cannot be sent, as
 * question.rs's `answers_for`: membership and counts only. */
export function answersFor(
  set: QuestionSet,
  answers: readonly QuestionAnswer[],
): Parsed<Record<string, string>> {
  const stray = answers.find((a) => !set.some((q) => q.question === a.question));
  if (stray !== undefined) return { refused: `No question reads "${stray.question}".` };
  const map: Record<string, string> = {};
  for (const question of set) {
    const q = question.question;
    const mine = answers.filter((a) => a.question === q);
    if (mine.length === 0) return { refused: `Answer every question: "${q}" has no answer.` };
    if (mine.length > 1) return { refused: `"${q}" is answered twice.` };
    const answer = mine[0];
    const seen: string[] = [];
    for (const label of answer.picked) {
      if (!question.options.some((o) => o.label === label)) {
        return { refused: `"${label}" is not an option of "${q}".` };
      }
      if (seen.includes(label)) return { refused: `"${label}" is picked twice for "${q}".` };
      seen.push(label);
    }
    const other = answer.other === null || answer.other === undefined ? null : clean(answer.other);
    if (other !== null && [...other].length > OTHER_CHARS) {
      return { refused: `Your answer for "${q}" is over ${OTHER_CHARS} characters.` };
    }
    const values = [...answer.picked];
    if (other !== null && other !== '') values.push(other);
    if (values.length === 0) {
      return {
        refused:
          other !== null
            ? `Type your answer for "${q}", or pick an option.`
            : `Answer every question: "${q}" has no answer.`,
      };
    }
    if (!question.multiSelect && values.length > 1) return { refused: `"${q}" takes one answer.` };
    map[q] = question.multiSelect ? join(values) : values[0];
  }
  return { ok: map };
}
