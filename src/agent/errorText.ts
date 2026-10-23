/**
 * A failure's words, as the conversation shows them.
 *
 * Claude Code can say a lot when something fails: a refused call wraps its
 * words in `<tool_use_error>`, and one naming a tool the run did not hold goes
 * on to list every tool it did, ten thousand characters on one line. Shown
 * whole, that buried the transcript under one red block. The summary is its
 * first lines; the whole stays one click away, so the evidence is never
 * hidden, only summarised (FailureNoticeCard's rule).
 */

/** How many lines of a failure the summary keeps. */
export const ERROR_SUMMARY_LINES = 3;

/** How many characters it keeps, for words that never break a line. */
export const ERROR_SUMMARY_CHARS = 280;

const OPEN = /^\s*<tool_use_error>\s*/;
const CLOSE = /\s*<\/tool_use_error>\s*$/;

/** `text` without the `<tool_use_error>` tags around it, either or both. */
export function unwrapToolError(text: string): string {
  return text.replace(OPEN, '').replace(CLOSE, '');
}

export interface ErrorText {
  /** All of it, unwrapped. */
  full: string;
  /** Its first lines, cut with an ellipsis when there was more. */
  summary: string;
  /** The summary left something out. */
  cut: boolean;
}

/** What a failure shows at once, and whether anything is left to unfold. */
export function readErrorText(raw: string): ErrorText {
  const full = unwrapToolError(raw).trim();
  const lines = full.split('\n');
  let summary = lines.slice(0, ERROR_SUMMARY_LINES).join('\n').trimEnd();
  if (summary.length > ERROR_SUMMARY_CHARS) {
    summary = summary.slice(0, ERROR_SUMMARY_CHARS).trimEnd();
  }
  const cut = summary !== full;
  return { full, summary: cut ? `${summary}…` : summary, cut };
}
