import RUN_OPTIONS from '../../shared/policy/run-options.v1.json';

/**
 * What a run may ask Claude Code for (M56.5): a model and an effort, from
 * `shared/policy/run-options.v1.json`. Rust (`src-tauri/src/agent/run_options.rs`)
 * reads the same bytes and refuses a run that names anything else; both
 * replay the artifact's cases, so no list is typed in either language.
 *
 * Unset (absent or blank) is always valid: no flag, and Claude Code's own
 * default, which this module names `CLAUDE_CODE_DEFAULT`.
 */

export interface RunOption {
  id: string;
  label: string;
}

/** What an unset model or effort reads as, everywhere it is shown. */
export const CLAUDE_CODE_DEFAULT = 'Claude Code default';

/** The levels `--effort` takes, in the artifact's order. */
export const EFFORT_LEVELS: readonly RunOption[] = RUN_OPTIONS.effort_levels;

/** The aliases the picker offers first; any model name is still allowed. */
export const MODEL_SUGGESTIONS: readonly RunOption[] = RUN_OPTIONS.model_suggestions;

/** A model and an effort, as a conversation or a record holds them. */
export interface RunChoice {
  model: string | null;
  effort: string | null;
}

/** Absent, or nothing but whitespace: no flag. */
export function isUnset(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

/** One of the artifact's effort ids, exactly. */
export function isEffort(value: string): boolean {
  return EFFORT_LEVELS.some((level) => level.id === value);
}

const ALNUM = /^[A-Za-z0-9]$/;

/**
 * Whether `value` has the model-name shape: an ASCII letter or digit first,
 * then letters, digits and the artifact's `also` characters, at most
 * `max_chars` long. Says nothing about whether the account can use it.
 */
export function isModelName(value: string): boolean {
  const { max_chars: maxChars, also } = RUN_OPTIONS.model;
  const chars = Array.from(value);
  if (chars.length === 0 || chars.length > maxChars) return false;
  if (!ALNUM.test(chars[0])) return false;
  return chars.every((c) => ALNUM.test(c) || also.includes(c));
}

/** The level's label ("Extra high"), or the raw value when it is none. */
export function effortLabel(value: string): string {
  return EFFORT_LEVELS.find((level) => level.id === value)?.label ?? value;
}

/** The suggestion's label ("Opus"), or the raw id for any other name. */
export function modelLabel(value: string): string {
  return MODEL_SUGGESTIONS.find((model) => model.id === value)?.label ?? value;
}

/** The value as a refusal prints it: cut, then JSON-quoted, as Rust does. */
function quoted(value: string): string {
  const chars = Array.from(value);
  const cut =
    chars.length > RUN_OPTIONS.value_chars
      ? `${chars.slice(0, RUN_OPTIONS.value_chars).join('')}…`
      : value;
  return JSON.stringify(cut);
}

function spokenList(ids: string[]): string {
  if (ids.length < 2) return ids.join('');
  return `${ids.slice(0, -1).join(', ')} or ${ids[ids.length - 1]}`;
}

/** Rust's refusal for this effort, word for word, or null when it would run. */
export function effortRefusal(value: string | null | undefined): string | null {
  if (isUnset(value) || isEffort(value as string)) return null;
  return RUN_OPTIONS.messages.effort
    .replace('{levels}', spokenList(EFFORT_LEVELS.map((level) => level.id)))
    .replace('{value}', quoted(value as string));
}

/** Rust's refusal for this model, word for word, or null when it would run. */
export function modelRefusal(value: string | null | undefined): string | null {
  if (isUnset(value) || isModelName(value as string)) return null;
  return RUN_OPTIONS.messages.model
    .replace('{aliases}', MODEL_SUGGESTIONS.map((model) => model.id).join(', '))
    .replace('{value}', quoted(value as string));
}

/** The first refusal in argv order (model, then effort), or null. */
export function runOptionsRefusal(choice: Partial<RunChoice>): string | null {
  return modelRefusal(choice.model) ?? effortRefusal(choice.effort);
}

/**
 * A stored value as a choice: trimmed, and null when blank or not a string.
 * Whether it is one Claude Code takes is asked separately.
 */
export function storedChoice(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
