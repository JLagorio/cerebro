/**
 * An ask-first write's draft as a form (M57.4b): pure, with the tool's input
 * schema passed in. Any tool's schema projects to one flat field per
 * top-level property the person can edit in place (text, a checkbox, a
 * number, a choice) and one whole-draft field, the input as JSON, which
 * holds everything else: objects, lists and unions. No tool is named here,
 * so a new confirmable tool gets its form from its manifest row alone.
 *
 * The form checks only what it can check totally: the draft is an object,
 * holds every required key and no undeclared one, and gives each key a
 * value of its declared type (`draftRefusal`, in Rust's words). Rust checks
 * the edit again at the answer (`policy::tools::validate_input`, then the
 * run's grant and the corpus) and at the write.
 */

/** The whole-draft field's key: the input as JSON. */
export const DRAFT_FIELD = 'draft';

export type Draft = Record<string, unknown>;

export type DraftFieldKind = 'text' | 'boolean' | 'integer' | 'number' | 'choice' | 'json';

export interface DraftField {
  /** The property's name, or DRAFT_FIELD for the whole draft. */
  key: string;
  kind: DraftFieldKind;
  /** The schema's description, if it has one. */
  hint: string | null;
  required: boolean;
  /** May the value be null? */
  nullable: boolean;
  /** A choice's options, in schema order; empty for any other kind. */
  options: string[];
  /** The draft's value: the argument as asked (undefined when absent), or
   * the whole draft pretty-printed for DRAFT_FIELD. */
  value: unknown;
}

export interface DraftForm {
  title: string;
  /** The flat fields in schema order, then the whole draft. */
  fields: DraftField[];
  required: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Is `value` a draft: a JSON object, not a list or null? */
export function isDraft(value: unknown): value is Draft {
  return asRecord(value) !== null;
}

/** `text` as a draft, or null when it is not JSON or not an object. */
export function parseDraft(text: string): Draft | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isDraft(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Conservative editor capability: a token must survive the JS object seam
 * exactly. This is not native schema validation or canonicalization. */
export function editableJsonNumber(text: string): boolean {
  return /^-?(?:0|[1-9]\d*)$/.test(text) && Number.isSafeInteger(Number(text)) && String(Number(text)) === text;
}
/** Skip complete string tokens; callers separately validate JSON syntax. */
export function editableJsonNumbers(text: string): boolean {
  const tokens = text.matchAll(/("(?:[^"\\]|\\.)*")|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g);
  for (const token of tokens) if (token[2] !== undefined && !editableJsonNumber(token[2])) return false;
  return true;
}

/** A draft as the whole-draft field shows it. */
export function prettyDraft(draft: Draft): string {
  return JSON.stringify(draft, null, 2);
}

interface Reading {
  kind: Exclude<DraftFieldKind, 'json'>;
  nullable: boolean;
  options: string[];
}

function isNullSchema(schema: unknown): boolean {
  const s = asRecord(schema);
  return s !== null && (s.type === 'null' || (Object.hasOwn(s, 'const') && s.const === null));
}

const FLAT: Record<string, Reading['kind']> = {
  string: 'text',
  boolean: 'boolean',
  integer: 'integer',
  number: 'number',
};

/** How one property reads as a flat field, or null when only the whole draft
 * can hold it. A nullable type, or a union of one schema and null, reads as
 * that schema; an enum of strings, or a union of string consts, is a choice. */
function readProperty(schema: unknown): Reading | null {
  const s = asRecord(schema);
  if (s === null) return null;
  const variants = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  if (variants !== null) {
    const kept = variants.filter((v) => !isNullSchema(v));
    const nullable = kept.length < variants.length;
    if (kept.length === 1) {
      const inner = readProperty(kept[0]);
      return inner === null ? null : { ...inner, nullable: inner.nullable || nullable };
    }
    const consts = kept.map((v) => asRecord(v)?.const);
    if (kept.length > 0 && consts.every((c): c is string => typeof c === 'string')) {
      return { kind: 'choice', nullable, options: consts };
    }
    return null;
  }
  const types =
    typeof s.type === 'string'
      ? [s.type]
      : Array.isArray(s.type)
        ? s.type.filter((t): t is string => typeof t === 'string')
        : [];
  const nullable = types.includes('null');
  const rest = types.filter((t) => t !== 'null');
  if (rest.length > 1) return null;
  if (Array.isArray(s.enum) && (rest.length === 0 || rest[0] === 'string')) {
    const options = s.enum.filter((e) => e !== null);
    if (!options.every((o): o is string => typeof o === 'string')) return null;
    return { kind: 'choice', nullable: nullable || s.enum.includes(null), options };
  }
  if (typeof s.const === 'string') return { kind: 'choice', nullable, options: [s.const] };
  const kind = rest.length === 1 ? FLAT[rest[0]] : undefined;
  return kind === undefined ? null : { kind, nullable, options: [] };
}

/** The schema's property map and required list; empty for a schema that
 * declares none. */
function schemaParts(schema: unknown): { properties: Record<string, unknown>; required: string[] } {
  const s = asRecord(schema);
  const properties = asRecord(s?.properties) ?? {};
  const required = Array.isArray(s?.required)
    ? s.required.filter((r): r is string => typeof r === 'string')
    : [];
  return { properties, required };
}

/**
 * The form a draft projects to: one flat field per property a flat field can
 * hold, pre-filled from `args`, then the whole draft. A property named like
 * the whole-draft field stays in the whole draft.
 */
export function projectDraftForm(title: string, schema: unknown, args: Draft): DraftForm {
  const { properties, required } = schemaParts(schema);
  const fields: DraftField[] = [];
  for (const [key, property] of Object.entries(properties)) {
    if (key === DRAFT_FIELD) continue;
    const reading = readProperty(property);
    if (reading === null) continue;
    const description = asRecord(property)?.description;
    fields.push({
      key,
      ...reading,
      hint: typeof description === 'string' ? description : null,
      required: required.includes(key),
      value: args[key],
    });
  }
  fields.push({
    key: DRAFT_FIELD,
    kind: 'json',
    hint: null,
    required: false,
    nullable: false,
    options: [],
    value: prettyDraft(args),
  });
  return { title, fields, required };
}

/**
 * The draft with the person's edits: an edited whole draft (an object, or
 * text that parses to one) replaces everything; otherwise each edited flat
 * field replaces its argument, undefined removes it, and every field left
 * alone keeps the draft's value. Whole-draft text that does not parse falls
 * back to the flat edits.
 */
export function applyDraftEdits(draft: Draft, edits: Record<string, unknown>): Draft {
  if (Object.hasOwn(edits, DRAFT_FIELD)) {
    const whole = edits[DRAFT_FIELD];
    const replaced = typeof whole === 'string' ? parseDraft(whole) : isDraft(whole) ? whole : null;
    if (replaced !== null) return { ...replaced };
  }
  const out: Draft = { ...draft };
  for (const [key, value] of Object.entries(edits)) {
    if (key === DRAFT_FIELD) continue;
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** `value` as JSON with every object's keys sorted, so key order is no
 * change (Rust's `canonical_hash` compares the same way). */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : isDraft(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  return JSON.stringify(sort(value)) ?? 'undefined';
}

/** The top-level keys whose values differ, added and removed ones included,
 * sorted: what the person changed (Rust's `changed_keys`). */
export function changedKeys(asked: Draft, approved: Draft): string[] {
  const keys = new Set([...Object.keys(asked), ...Object.keys(approved)]);
  return [...keys].filter((key) => canonical(asked[key]) !== canonical(approved[key])).sort();
}

const TYPE_WORDS: Record<string, string> = {
  string: 'a string',
  boolean: 'true or false',
  integer: 'a whole number',
  number: 'a number',
  object: 'an object',
  array: 'a list',
  null: 'null',
};

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'object':
      return isDraft(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/**
 * Why `input` is not the shape `schema` declares, in the words of Rust's
 * `policy::tools::validate_input`, or null when it is: an object, every
 * required key, no undeclared key, and each value of its declared type.
 */
export function draftRefusal(schema: unknown, input: unknown): string | null {
  if (!isDraft(input)) return 'The edited draft must be a JSON object.';
  const { properties, required } = schemaParts(schema);
  for (const key of required) {
    if (!Object.hasOwn(input, key)) {
      return `The edited draft leaves out ${key}, which this tool requires.`;
    }
  }
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(properties, key)) {
      return `The edited draft has ${key}, which this tool does not take.`;
    }
    const declared = asRecord(properties[key])?.type;
    const types =
      typeof declared === 'string'
        ? [declared]
        : Array.isArray(declared)
          ? declared.filter((t): t is string => typeof t === 'string')
          : null;
    if (types === null) continue;
    if (!types.some((t) => hasType(value, t))) {
      const words = types.map((t) => TYPE_WORDS[t] ?? t);
      return `The edited draft's ${key} must be ${words.join(' or ')}.`;
    }
  }
  return null;
}

/** A flat field's value as its input shows it: text, or '' for none. */
export function fieldText(field: DraftField): string {
  const { value } = field;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/**
 * What a flat field's text means as an argument, or `invalid` when it means
 * nothing the field takes. Empty text is an empty string for a required text
 * field, null for a nullable one, and otherwise removes the argument; a
 * required number or choice needs a value. An integer refuses a fraction.
 */
export function readFieldText(field: DraftField, text: string): { value: unknown } | 'invalid' {
  if (text === '') {
    if (field.kind === 'text' && field.required) return { value: '' };
    if (field.required) return 'invalid';
    return { value: field.nullable ? null : undefined };
  }
  switch (field.kind) {
    case 'integer':
      return /^-?\d+$/.test(text.trim()) ? { value: Number(text.trim()) } : 'invalid';
    case 'number': {
      const n = Number(text.trim());
      return text.trim() !== '' && Number.isFinite(n) ? { value: n } : 'invalid';
    }
    case 'choice':
      return field.options.includes(text) ? { value: text } : 'invalid';
    default:
      return { value: text };
  }
}
