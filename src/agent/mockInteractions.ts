import type { PendingInteraction, PersonAnswer } from './types';
import { bareToolName } from '@/lib/policy/tools';

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
 */

/** The refusal code and the words Rust's book gives a late answer. */
export const NO_LONGER_WAITING = 'no_longer_waiting';
export const STALE = 'No longer waiting: this request was already answered or cancelled.';

/** What the model is told when the person declines (Rust's `DECLINED`). */
export const DECLINED = 'The person declined this call, so it did not run.';

/** A deny as the model reads it: Rust's words, then the person's own. */
export function declinedText(answer: PersonAnswer): string {
  const said = answer.kind === 'deny' ? (answer.message ?? '').trim() : '';
  return said === '' ? DECLINED : `${DECLINED} They said: ${said}`;
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
  | { resume: MockResume; card: PendingInteraction }
  | { refused: { code: string; message: string } };

/** Take an answer: only for a card waiting in `vault`. */
export function answerMockInteraction(vault: string, id: string): MockAnswer {
  const entry = book.get(id);
  if (entry === undefined || entry.state !== 'waiting' || entry.vault !== vault) {
    return { refused: { code: NO_LONGER_WAITING, message: STALE } };
  }
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
