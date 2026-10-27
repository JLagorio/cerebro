import { useId, useMemo, useState } from 'react';
import { Select } from '@/components/ui/Select';
import {
  applyDraftEdits,
  changedKeys,
  DRAFT_FIELD,
  draftRefusal,
  editableJsonNumber,
  editableJsonNumbers,
  fieldText,
  parseDraft,
  prettyDraft,
  projectDraftForm,
  readFieldText,
  type Draft,
  type DraftField,
} from '@/engine/writeDraft';

/**
 * An ask-first write's draft, editable before Allow (M57.4b): the form
 * `engine/writeDraft` projects from the tool's input schema. One control per
 * flat field, labelled by its property name with the schema's description as
 * its hint and required fields marked, then "Edit as JSON", the whole draft.
 * Opening the JSON makes the other fields read-only, and while it is open the
 * JSON is the draft; closing it keeps a JSON object and drops anything else.
 *
 * Controlled and without buttons, so the card that holds it owns its
 * answers: every change reports the input, whether it is valid, and whether
 * it differs from the asked draft. It checks only what it can check totally
 * (an object, required keys, declared keys, types); Rust checks the edit
 * again at the answer and at the write. Everything shows as text, never as
 * markup.
 */

/** The form's words (Appendix C, M57.4b). */
export const DRAFT_COPY = {
  json: 'Edit as JSON',
  readOnly: 'These fields are read-only while the JSON is edited.',
  notObject: 'Not a JSON object',
  required: 'required',
  none: '—',
} as const;

/** Text this long, or holding a line break, edits in a text area. */
const LONG_TEXT = 80;

export interface DraftChange {
  input: Draft;
  valid: boolean;
  edited: boolean;
}

interface Props {
  title: string;
  schema: unknown;
  /** The draft as the agent asked it. */
  draft: Draft;
  disabled?: boolean;
  /** Refuse numeric text this object-based editor cannot preserve exactly. */
  exactNumbersOnly?: boolean;
  onChange: (change: DraftChange) => void;
}

interface State {
  /** What the flat fields edit: the asked draft, or a JSON edit kept. */
  base: Draft;
  /** Each touched flat field's text, or its checkbox. */
  edits: Record<string, string | boolean>;
  json: { seed: string; text: string } | null;
}

/** The flat fields' edits as arguments, and whether one of them means
 * nothing its field takes. */
function flatEdits(
  fields: DraftField[],
  edits: State['edits'],
  exactNumbersOnly = false,
): { values: Record<string, unknown>; invalid: boolean } {
  const values: Record<string, unknown> = {};
  let invalid = false;
  for (const field of fields) {
    if (!Object.hasOwn(edits, field.key)) continue;
    const edit = edits[field.key];
    if (typeof edit === 'boolean') {
      values[field.key] = edit;
      continue;
    }
    if (exactNumbersOnly && numericEditUnsupported(field, edit)) {
      invalid = true;
      continue;
    }
    const read = readFieldText(field, edit);
    if (read === 'invalid') invalid = true;
    else values[field.key] = read.value;
  }
  return { values, invalid };
}

function numericEditUnsupported(field: DraftField, text: string): boolean {
  return (
    (field.kind === 'number' || field.kind === 'integer') &&
    text.trim() !== '' &&
    !editableJsonNumber(text.trim())
  );
}

function changeOf(
  schema: unknown,
  asked: Draft,
  state: State,
  fields: DraftField[],
  exactNumbersOnly = false,
): DraftChange {
  if (state.json !== null && state.json.text !== state.json.seed) {
    if (exactNumbersOnly && !editableJsonNumbers(state.json.text))
      return { input: asked, valid: false, edited: true };
    const parsed = parseDraft(state.json.text);
    if (parsed === null) return { input: asked, valid: false, edited: true };
    return {
      input: parsed,
      valid: draftRefusal(schema, parsed) === null,
      edited: changedKeys(asked, parsed).length > 0,
    };
  }
  const { values, invalid } = flatEdits(fields, state.edits, exactNumbersOnly);
  const input = applyDraftEdits(state.base, values);
  return {
    input,
    valid: !invalid && draftRefusal(schema, input) === null,
    edited: invalid || changedKeys(asked, input).length > 0,
  };
}

export function WriteDraftForm({
  title,
  schema,
  draft,
  disabled = false,
  exactNumbersOnly = false,
  onChange,
}: Props) {
  const id = useId();
  const [state, setState] = useState<State>({ base: draft, edits: {}, json: null });
  const form = useMemo(
    () => projectDraftForm(title, schema, state.base),
    [title, schema, state.base],
  );
  const flat = form.fields.filter((field) => field.key !== DRAFT_FIELD);
  const jsonOpen = state.json !== null;
  const numbersInvalid =
    exactNumbersOnly &&
    (state.json !== null
      ? !editableJsonNumbers(state.json.text)
      : flat.some((field) => {
          const text = state.edits[field.key];
          return typeof text === 'string' && numericEditUnsupported(field, text);
        }));
  const jsonInvalid =
    state.json !== null && !numbersInvalid && parseDraft(state.json.text) === null;
  const locked = disabled || jsonOpen;

  const update = (next: State) => {
    setState(next);
    const fields =
      next.base === state.base ? flat : projectDraftForm(title, schema, next.base).fields;
    onChange(changeOf(schema, draft, next, fields, exactNumbersOnly));
  };

  const edit = (key: string, value: string | boolean) =>
    update({ ...state, edits: { ...state.edits, [key]: value } });

  const toggleJson = (open: boolean) => {
    // Do not let a representation switch discard or normalize an invalid edit.
    if (exactNumbersOnly && !changeOf(schema, draft, state, flat, true).valid) return;
    if (open) {
      const current = changeOf(schema, draft, state, flat, exactNumbersOnly).input;
      const seed = prettyDraft(current);
      update({ ...state, json: { seed, text: seed } });
      return;
    }
    const kept = state.json === null ? null : parseDraft(state.json.text);
    update(kept === null ? { ...state, json: null } : { base: kept, edits: {}, json: null });
  };

  return (
    <div data-testid="write-draft-form" className="flex flex-col gap-1.5">
      {flat.map((field) => {
        const control = `${id}-${field.key}`;
        const edited = state.edits[field.key];
        const text = typeof edited === 'string' ? edited : fieldText(field);
        const invalid =
          typeof edited === 'string' &&
          ((exactNumbersOnly && numericEditUnsupported(field, edited)) ||
            readFieldText(field, edited) === 'invalid')
            ? true
            : undefined;
        const common = {
          id: control,
          'data-testid': `write-draft-field-${field.key}`,
          'data-required': field.required ? 'true' : undefined,
          'aria-required': field.required || undefined,
          'aria-invalid': invalid,
        };
        const seeded = fieldText(field);
        return (
          <div key={field.key} className="flex flex-col gap-0.5">
            <label
              htmlFor={control}
              className="flex items-center gap-1 [font-family:var(--font-mono)] text-2xs text-n-700"
            >
              {field.key}
              {field.required && (
                <span
                  data-testid="write-draft-required"
                  aria-hidden="true"
                  title={DRAFT_COPY.required}
                  className="text-cortex-600"
                >
                  *
                </span>
              )}
            </label>
            {field.hint !== null && (
              <span className="text-metadata text-(--text-meta)" data-testid="write-draft-hint">
                {field.hint}
              </span>
            )}
            {field.kind === 'boolean' ? (
              <input
                {...common}
                type="checkbox"
                checked={typeof edited === 'boolean' ? edited : field.value === true}
                disabled={locked}
                onChange={(e) => edit(field.key, e.target.checked)}
                className="self-start"
              />
            ) : field.kind === 'choice' ? (
              // A listbox button carries no required state of its own; the
              // label's mark says it. None is a row only where the schema
              // takes no value; a required field without one shows it as the
              // placeholder, and a value off the schema's list shows as
              // asked, for Rust to refuse rather than for the form to hide.
              <Select
                id={control}
                testId={`write-draft-field-${field.key}`}
                size="sm"
                value={text}
                disabled={locked}
                invalid={invalid === true}
                placeholder={DRAFT_COPY.none}
                onChange={(next) => edit(field.key, next)}
                options={[
                  ...(!field.required || field.nullable
                    ? [{ value: '', label: DRAFT_COPY.none }]
                    : []),
                  ...field.options.map((option) => ({ value: option, label: option })),
                  ...(text === '' || field.options.includes(text)
                    ? []
                    : [{ value: text, label: text }]),
                ]}
              />
            ) : field.kind === 'text' && (seeded.includes('\n') || seeded.length > LONG_TEXT) ? (
              <textarea
                {...common}
                value={text}
                readOnly={locked}
                rows={Math.min(8, Math.max(3, seeded.split('\n').length))}
                onChange={(e) => edit(field.key, e.target.value)}
                className="resize-y rounded-md border border-n-200 bg-n-0 px-1.5 py-1 [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-800"
              />
            ) : (
              <input
                {...common}
                type="text"
                inputMode={
                  field.kind === 'integer'
                    ? 'numeric'
                    : field.kind === 'number'
                      ? 'decimal'
                      : undefined
                }
                value={text}
                readOnly={locked}
                onChange={(e) => edit(field.key, e.target.value)}
                className="rounded-md border border-n-200 bg-n-0 px-1.5 py-1 text-xs text-n-800"
              />
            )}
          </div>
        );
      })}
      {numbersInvalid && (
        <p role="alert" className="text-2xs text-danger-600">
          This edit cannot preserve its exact numbers. Correct the text before approving.
        </p>
      )}
      {jsonOpen && flat.length > 0 && (
        <div data-testid="write-draft-readonly" className="text-metadata text-(--text-meta)">
          {DRAFT_COPY.readOnly}
        </div>
      )}
      <label className="flex items-center gap-1.5 text-2xs text-n-600">
        <input
          type="checkbox"
          data-testid="write-draft-json-toggle"
          checked={jsonOpen}
          disabled={disabled}
          onChange={(e) => toggleJson(e.target.checked)}
        />
        {DRAFT_COPY.json}
      </label>
      {state.json !== null && (
        <>
          <textarea
            data-testid="write-draft-json"
            aria-label={DRAFT_COPY.json}
            value={state.json.text}
            readOnly={disabled}
            rows={8}
            aria-invalid={jsonInvalid || numbersInvalid || undefined}
            onChange={(e) =>
              update({
                ...state,
                json: { seed: state.json?.seed ?? '', text: e.target.value },
              })
            }
            className="resize-y rounded-md border border-n-200 bg-n-0 px-1.5 py-1 [font-family:var(--font-mono)] text-2xs leading-[15px] text-n-800"
          />
          {jsonInvalid && (
            <div data-testid="write-draft-json-invalid" className="text-2xs text-danger-600">
              {DRAFT_COPY.notObject}
            </div>
          )}
        </>
      )}
    </div>
  );
}
