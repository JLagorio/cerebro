import type { PendingInteraction, PersonAnswer } from './types';
import { answersFor, parseQuestions, type QuestionSet } from '@/engine/questionForm';
import { draftRefusal } from '@/engine/writeDraft';
import { questionMalformed } from '@/lib/policy/toolApproval';
import { bareToolName, toolSchema } from '@/lib/policy/tools';

/**
 * The browser's ask seam (M57.1): the mock of Rust's book
 * (src-tauri/src/agent/interaction.rs), so the panel's card, its answers and
 * the turn that resumes after them run in `pnpm dev`, vitest and Playwright.
 *
 * Which calls ask is a test seam, as `CEREBRO_ASK_TOOLS` is in a debug
 * build: `window.__cerebroMockAsk` names the tools (bare or as the CLI spells
 * them). Unset, nothing asks. Like Rust's, the book takes an answer only for
 * a card that is waiting in the same vault, one at a time; a late one is
 * refused `no_longer_waiting` in Rust's words. A call nobody answered is
 * refused as not answered when its thread sends again (the settle).
 *
 * A question card (M57.3) is Rust's too: its questions parse by the shared
 * rules (`mockQuestions`), a set no card can show is refused in Rust's words,
 * and its answers are checked by the same membership and count rules before
 * the book takes them (`answerMockInteraction`).
 *
 * An edited draft (M57.4b) is taken as Rust's book takes it: only with an
 * Allow of a write card, and only once it fits the tool's schema, refused
 * in Rust's words otherwise (`draftRefusal`, `validate_input`'s twin). The
 * mock's write then judges the edited input through the tool's own
 * refusals (`agentCreate`), as Rust's dispatch does.
 */

/** The refusal code and the words Rust's book gives a late answer. */
export const NO_LONGER_WAITING = 'no_longer_waiting';
export const STALE = 'No longer waiting: this request was already answered or cancelled.';

/** An answer that does not fit its card (Rust's `MALFORMED_ARGUMENTS`). */
export const MALFORMED_ARGUMENTS = 'malformed_arguments';
/** Rust's words for an Allow on a question card (M57.3). */
export const ANSWER_THE_QUESTION = 'A question is answered with its answers.';
/** Rust's words for answers sent to a card that asks no question (M57.3). */
export const NOT_A_QUESTION = 'Only a question takes answers.';
/** Rust's words for an edited draft on anything but an Allow of a write
 * card (M57.4b, `EDIT_MISFIT`). */
export const EDIT_MISFIT = 'Only an Allow of a page write carries an edited draft.';

/** What the model is told when the person declines (Rust's `DECLINED`). */
export const DECLINED = 'The person declined this call, so it did not run.';

/** A deny as the model reads it: Rust's words, then the person's own. */
export function declinedText(answer: PersonAnswer): string {
  const said = answer.kind === 'deny' ? (answer.message ?? '').trim() : '';
  return said === '' ? DECLINED : `${DECLINED} They said: ${said}`;
}

/** A question call's questions (M57.3), as Rust's gate reads them: the set a
 * card shows, or, for a set no card can show, what the model is told. */
export function mockQuestions(input: unknown): { questions: QuestionSet } | { deny: string } {
  const parsed = parseQuestions(input);
  return 'ok' in parsed ? { questions: parsed.ok } : { deny: questionMalformed(parsed.refused) };
}

/** Make a registered card the question card Rust's book draws (M57.3). */
export function markMockQuestion(card: PendingInteraction, questions: QuestionSet): void {
  Object.assign(card, { kind: 'question', questions });
}

/** What Claude Code hands the model once a question is answered, in the
 * shape 2.1.250's tool result takes (the ask-question spike): each question
 * and its answer, quoted. */
export function answeredText(answers: Record<string, string>): string {
  const pairs = Object.entries(answers).map(
    ([q, a]) => `${JSON.stringify(q)}=${JSON.stringify(a)}`,
  );
  return `User has answered your questions: ${pairs.join(', ')}.`;
}

/** Why `answer` cannot answer `card`, in Rust's words, or null when it fits:
 * a question card takes its answers, checked by the shared rules, or a
 * decline; any other card takes no answers; and only a write card's Allow
 * takes an edited draft of the tool's shape (M57.4b). */
function misfit(card: PendingInteraction, answer: PersonAnswer): string | null {
  if (answer.kind === 'allow' && answer.updatedInput !== undefined) {
    if (card.kind !== 'write') return EDIT_MISFIT;
    const schema = toolSchema(card.tool_name);
    if (schema === null) return `${bareToolName(card.tool_name)} takes no edited draft.`;
    return draftRefusal(schema, answer.updatedInput);
  }
  if (card.kind === 'question') {
    if (answer.kind === 'allow') return ANSWER_THE_QUESTION;
    if (answer.kind !== 'answers') return null;
    const checked = answersFor(card.questions ?? [], answer.answers);
    return 'refused' in checked ? checked.refused : null;
  }
  return answer.kind === 'answers' ? NOT_A_QUESTION : null;
}

/** Starts the turn that resumes after an answer; the mock agent builds it. */
export type MockResume = (answer: PersonAnswer) => void;

type State = 'registered' | 'waiting' | 'answering' | 'cancelled';

interface Entry {
  card: PendingInteraction;
  vault: string;
  state: State;
  seq: number;
  resume: MockResume;
}

const book = new Map<string, Entry>();
let seq = 0;

/** Does the seam ask for `toolName`? */
export function mockAsks(toolName: string): boolean {
  const named = (globalThis as { __cerebroMockAsk?: unknown }).__cerebroMockAsk;
  if (!Array.isArray(named)) return false;
  const bare = bareToolName(toolName);
  return named.some((name) => typeof name === 'string' && bareToolName(name) === bare);
}

/** 128 random bits, hex, as Rust mints a card's id. */
function mintId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The input as a card shows it: pretty JSON when it is JSON. */
function pretty(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

/** The card's summary: the tool's name and the path it aims at, if any. */
function summaryOf(toolName: string, input: string): string {
  const bare = bareToolName(toolName).replace(/_/g, ' ');
  try {
    const path = (JSON.parse(input) as Record<string, unknown>).path;
    if (typeof path === 'string' && path !== '') return `${bare} · ${path}`;
  } catch {
    // Not JSON: the name alone.
  }
  return bare;
}

/** The gate deferred a call: registered, not yet a card. Returns its id. */
export function registerMockInteraction(
  vault: string,
  sessionId: string,
  toolId: string,
  toolName: string,
  input: string,
  resume: MockResume,
): string {
  const id = mintId();
  seq += 1;
  book.set(id, {
    card: {
      id,
      kind: 'permission',
      tool_name: toolName,
      tool_id: toolId,
      session_id: sessionId,
      summary: summaryOf(toolName, input),
      input: pretty(input),
      asked_at: new Date().toISOString(),
    },
    vault,
    state: 'registered',
    seq,
    resume,
  });
  return id;
}

/** The run's stream confirmed the deferral: the card, once. */
export function confirmMockInteraction(id: string): PendingInteraction | null {
  const entry = book.get(id);
  if (entry === undefined || entry.state !== 'registered') return null;
  entry.state = 'waiting';
  return entry.card;
}

export type MockAnswer =
  { resume: MockResume; card: PendingInteraction } | { refused: { code: string; message: string } };

/** Take an answer: only for a card waiting in `vault`, and only one that
 * fits its card (M57.3); a misfit is refused and the card waits on. */
export function answerMockInteraction(
  vault: string,
  id: string,
  answer?: PersonAnswer,
): MockAnswer {
  const entry = book.get(id);
  if (entry === undefined || entry.state !== 'waiting' || entry.vault !== vault) {
    return { refused: { code: NO_LONGER_WAITING, message: STALE } };
  }
  const refused = answer === undefined ? null : misfit(entry.card, answer);
  if (refused !== null) return { refused: { code: MALFORMED_ARGUMENTS, message: refused } };
  entry.state = 'answering';
  return { resume: entry.resume, card: entry.card };
}

/** The resume started and read its answer: the call is done with. */
export function finishMockAnswer(id: string): void {
  if (book.get(id)?.state === 'answering') book.delete(id);
}

/** The resume could not start: the card waits again. */
export function abortMockAnswer(id: string): void {
  const entry = book.get(id);
  if (entry?.state === 'answering') entry.state = 'waiting';
}

/** Cancel a call nobody answered; false when it was not waiting. */
export function cancelMockInteraction(id: string): boolean {
  const entry = book.get(id);
  if (entry === undefined || (entry.state !== 'waiting' && entry.state !== 'registered')) {
    return false;
  }
  entry.state = 'cancelled';
  return true;
}

/** The cards waiting in `vault`, oldest first. */
export function listMockInteractions(vault: string): PendingInteraction[] {
  return [...book.values()]
    .filter((entry) => entry.vault === vault && entry.state === 'waiting')
    .sort((a, b) => a.seq - b.seq)
    .map((entry) => entry.card);
}

/**
 * A new send in `sessionId` (the settle): every call of that session nobody
 * answered, waiting or cancelled, is refused and forgotten, so the new text
 * runs. Returns the refused calls' tool ids.
 */
export function settleMockSession(sessionId: string): string[] {
  const refused: string[] = [];
  for (const [id, entry] of [...book]) {
    if (entry.card.session_id !== sessionId || entry.state === 'answering') continue;
    refused.push(entry.card.tool_id);
    book.delete(id);
  }
  return refused;
}

/** Test seam: an empty book. */
export function resetMockInteractions(): void {
  book.clear();
  seq = 0;
}
