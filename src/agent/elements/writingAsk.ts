/**
 * The editor's asks as their elements draw them (M91.14): Ask AI on a
 * selection (Prompt Input, Suggestion rows, a working line, and the
 * Confirmation that takes or leaves each change) and the AI block's
 * question and run. Pure: words and states, never a run.
 */

/** What Ask AI's working line says while the passage is rewritten. */
export function askAiWorking(skill?: string): string {
  return skill === undefined ? 'Rewriting the passage…' : `Running /${skill} on the passage…`;
}

/** The card that asks which of the rewrite's changes to take. */
export interface RewriteDecision {
  /** Its question; or, when nothing changed, that the passage came back as it was. */
  title: string;
  /** How many changes are taken, and how to change that. Null with none to take. */
  summary: string | null;
  /** The answer that writes: what is taken, or the passage as it was. It
   *  says what the click does — "Apply" over an unchanged passage would not. */
  apply: 'Apply' | 'Keep mine';
}

export function rewriteDecision(changes: number, accepted: number): RewriteDecision {
  if (changes === 0) {
    return {
      title: 'The assistant left the passage as it was.',
      summary: null,
      apply: 'Keep mine',
    };
  }
  return {
    title: 'Apply the rewrite?',
    summary: `${accepted} of ${changes} change${changes === 1 ? '' : 's'} · click one to toggle it`,
    apply: accepted === 0 ? 'Keep mine' : 'Apply',
  };
}

/** The AI block's run button: its word, and whether it carries the working light. */
export interface AiBlockRun {
  label: 'Answer' | 'Recompute' | 'Working…';
  working: boolean;
}

export function aiBlockRun(generated: string, running: boolean): AiBlockRun {
  if (running) return { label: 'Working…', working: true };
  return { label: generated === '' ? 'Answer' : 'Recompute', working: false };
}
