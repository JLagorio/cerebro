/**
 * Schema-checked field writes (M60.4): the planner under the agent's
 * `set_fields`, twin of `src-tauri/src/vault/set_fields.rs`.
 *
 * `set` replaces values; `add` and `remove` change list fields item by item
 * against the record's frontmatter as its bytes hold it now. Every value is
 * checked against the field its `type: Type` doc declares: choices store the
 * option's id (exact id, then `optionId(input)`, then the trimmed label
 * ignoring case), an unknown option is kept as written and named (M1), and
 * person and relation values are stored as `[[links]]`, spelled as given.
 * A link's type is checked only for a declared `target:` and a page the run
 * may read; option lists are named only when their source is readable.
 *
 * Pure: the mock backend (`agentSetFields` in src/lib/mockIpc.ts) reads the
 * bytes and writes them. Both twins replay
 * src-tauri/fixtures/set-fields-cases.json, which pins every word (D3).
 */

import { optionId, validateValue } from './properties';
import { kindFacts } from './fieldKindTable';
import { targetIndexFor } from './wikilink';
import type { Entry, FieldDef, Schema, TypeDef } from './types';

type Fields = Record<string, unknown>;

/** A parsed request: the record and the three key maps, in their order. */
export interface SetFieldsRequest {
  path: string;
  set: Fields;
  add: Fields;
  remove: Fields;
}

const OPS = ['set', 'add', 'remove'] as const;
type Op = (typeof OPS)[number];

const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read `set_fields`' arguments, or the plain error Rust's `parse_request`
 * gives. `expect_hash` is the caller's. */
export function parseSetFieldsRequest(args: Fields): { ok: SetFieldsRequest } | { error: string } {
  const path = args.path;
  if (typeof path !== 'string' || path.trim() === '') return { error: 'set_fields needs a path' };
  const maps: Fields[] = [];
  for (const op of OPS) {
    const raw = args[op];
    if (raw === undefined || raw === null) maps.push({});
    else if (isObject(raw)) maps.push(raw);
    else return { error: 'set, add and remove must be objects' };
  }
  if (maps.every((m) => Object.keys(m).length === 0)) {
    return { error: 'set_fields needs set, add or remove' };
  }
  for (let later = 1; later < OPS.length; later++) {
    for (const key of Object.keys(maps[later])) {
      const earlier = [0, 1].find((i) => i < later && Object.hasOwn(maps[i], key));
      if (earlier !== undefined) {
        return { error: `${key} appears in both ${OPS[earlier]} and ${OPS[later]}; send it once` };
      }
    }
  }
  return { ok: { path, set: maps[0], add: maps[1], remove: maps[2] } };
}

/** What the planner reads besides the record. */
export interface SetFieldsContext {
  entries: readonly Entry[];
  schema: Schema;
  recordPath: string;
  project: string | null;
  mayRead: (path: string) => boolean;
}

export type SetFieldsPlan = { patch: Fields; notes: string[] } | { refused: string[] };

const TYPE_KEY_PROBLEM =
  "type is the record's database, not one of its fields; set_fields cannot change it";

/** A value as a note names it (Rust's `display`). */
function display(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(display).join(', ');
  return JSON.stringify(value) ?? 'null';
}

function itemsOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return [...value];
  return [value];
}

/** JSON equality, objects compared whatever their key order. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

/** The page a trimmed value names when it is exactly one `[[link]]`. */
function oneLink(text: string): string | null {
  if (!text.startsWith('[[') || !text.endsWith(']]') || text.length < 4) return null;
  const inner = text.slice(2, -2);
  if (inner.includes('[') || inner.includes(']')) return null;
  const target = (inner.split('|')[0] ?? '').trim();
  return target === '' ? null : target;
}

/** A person or relation value as stored, or null when it is neither a page
 * name nor one link. */
function linkValue(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  if (oneLink(text) !== null) return text;
  if (text.includes('[') || text.includes(']')) return null;
  return `[[${text}]]`;
}

function targetOf(value: string): string {
  const text = value.trim();
  return oneLink(text) ?? text;
}

/** `normalizeFieldName`'s rule (src/app/typeActions.ts), held here because
 * the engine imports no app code. */
function normalizedKey(raw: string): string {
  return raw.trim().replace(/\s+/g, '_').toLowerCase().replace(/^_+/, '');
}

interface Choice {
  id: string;
  label: string;
}

interface Choices {
  list: Choice[];
  /** The file they come from; null for the default statuses. */
  source: string | null;
}

/** Exact id, then `optionId(input)` equal to an id, then the trimmed label
 * ignoring case: three passes over the whole list, in that order. */
function matchChoice(choices: readonly Choice[], input: string): Choice | null {
  const exact = choices.find((c) => c.id === input);
  if (exact !== undefined) return exact;
  const slug = optionId(input);
  const slugged = choices.find((c) => c.id === slug);
  if (slugged !== undefined) return slugged;
  const lower = input.trim().toLowerCase();
  return choices.find((c) => c.label.trim().toLowerCase() === lower) ?? null;
}

interface Line {
  key: string;
  base: string;
  clauses: string[];
}

const lineText = (line: Line): string => [`${line.key}: ${line.base}`, ...line.clauses].join('; ');

/** A change: the value to store, or null to remove the key; undefined is no
 * change. */
type Change = unknown;

/**
 * Plan a `set_fields` call against `current`, the record's frontmatter as its
 * bytes hold it now: the patch and a note per key, or every problem. The type
 * comes from `current`'s `type:`; a note with no type, or a type no Type doc
 * declares, is written unchecked, and its first note says so.
 */
export function planSetFields(
  ctx: SetFieldsContext,
  current: Fields,
  req: SetFieldsRequest,
): SetFieldsPlan {
  const typeName = typeof current.type === 'string' ? current.type : null;
  const notes: string[] = [];
  const problems: string[] = [];
  const patch: Fields = {};
  let declared: TypeDef | null = null;
  if (typeName === null) {
    notes.push(`Nothing was checked: ${req.path} has no type.`);
  } else {
    declared = ctx.schema.types.get(typeName) ?? null;
    if (declared === null) notes.push(`Nothing was checked: no Type doc declares ${typeName}.`);
  }
  const typeDoc =
    declared === null
      ? null
      : ([...ctx.entries].reverse().find((e) => e.type === 'Type' && e.title === declared.name)
          ?.path ?? null);
  const links = targetIndexFor(ctx.entries);
  const readable = (source: string | null) => source === null || ctx.mayRead(source);
  const sameLink = (a: string, b: string): boolean => {
    const ta = targetOf(a);
    const tb = targetOf(b);
    const x = links.resolveLink(ta)?.entry ?? null;
    const y = links.resolveLink(tb)?.entry ?? null;
    if (x !== null && y !== null) return x.path === y.path;
    return ta.toLowerCase() === tb.toLowerCase();
  };
  const same = (isLink: boolean, a: unknown, b: unknown): boolean =>
    isLink && typeof a === 'string' && typeof b === 'string' ? sameLink(a, b) : jsonEqual(a, b);

  const finish = (line: Line, change: Change) => {
    if (change !== undefined) patch[line.key] = change;
    notes.push(lineText(line));
  };

  const delta = (
    op: Op,
    key: string,
    items: unknown[],
    isLink: boolean,
  ): { line: Line; change: Change; added: unknown[] } => {
    let list = itemsOf(current[key]);
    const moved: unknown[] = [];
    const idle: unknown[] = [];
    for (const item of items) {
      const held = list.some((h) => same(isLink, h, item));
      if (op === 'add' && !held) {
        list.push(item);
        moved.push(item);
      } else if (op === 'remove' && held) {
        list = list.filter((h) => !same(isLink, h, item));
        moved.push(item);
      } else {
        idle.push(item);
      }
    }
    const clauses: string[] = [];
    if (idle.length > 0) {
      clauses.push(`${op === 'add' ? 'already held' : 'did not hold'} ${display(idle)}`);
    }
    if (moved.length === 0) {
      return { line: { key, base: 'unchanged', clauses }, change: undefined, added: [] };
    }
    const base = `${op === 'add' ? 'added' : 'removed'} ${display(moved)}`;
    let change: Change = list;
    if (list.length === 0) {
      clauses.push('now empty, so the key is gone');
      change = null;
    }
    return { line: { key, base, clauses }, change, added: op === 'add' ? moved : [] };
  };

  const replace = (
    key: string,
    input: unknown,
    stored: unknown,
  ): { line: Line; change: Change } => {
    const line = (base: string): Line => ({ key, base, clauses: [] });
    if (stored === null) {
      return Object.hasOwn(current, key)
        ? { line: line('removed'), change: null }
        : { line: line('unchanged'), change: undefined };
    }
    if (Object.hasOwn(current, key) && jsonEqual(current[key], stored)) {
      return { line: line('unchanged'), change: undefined };
    }
    const shown = display(stored);
    const given = display(input);
    const base = shown === given ? `set to ${shown}` : `set to ${shown} (from "${given}")`;
    return { line: line(base), change: stored };
  };

  const undeclaredKey = (op: Op, key: string, value: unknown, typeLabel: string | null) => {
    const { line, change } =
      op === 'set' ? replace(key, value, value) : delta(op, key, itemsOf(value), false);
    if (typeLabel !== null) line.clauses.push(`not declared on ${typeLabel}, written as given`);
    finish(line, change);
  };

  const choicesFor = (def: FieldDef, type: TypeDef): Choices => {
    if (kindFacts(def.kind).status_set) {
      const probe = probeEntry(ctx.recordPath, type.name, ctx.project);
      const from = ctx.schema.statusSourceFor(probe);
      return {
        list: ctx.schema.statusSetFor(probe).map((s) => ({ id: s.id, label: s.label })),
        source: from === 'project' ? ctx.project : from === 'type' ? typeDoc : null,
      };
    }
    return {
      list: (def.options ?? []).map((o) => ({ id: o.id, label: o.label })),
      source: typeDoc,
    };
  };

  const ghostClause = (ghost: string, choices: Choices): string => {
    let clause = `kept "${ghost}" as written, not one of its options`;
    if (choices.list.length > 0 && readable(choices.source)) {
      clause += ` (options: ${choices.list.map((c) => `${c.id} "${c.label}"`).join(', ')})`;
    }
    return clause;
  };

  const declaredKey = (op: Op, key: string, value: unknown, def: FieldDef, type: TypeDef) => {
    const facts = kindFacts(def.kind);
    const derived = facts.links && def.from !== undefined;
    const clears = op === 'set' && value === null;
    if ((facts.computed || derived) && !clears) {
      const probe = op === 'set' ? value : itemsOf(value);
      const problem = validateValue(def, probe);
      if (problem !== null) problems.push(problem);
      return;
    }
    if (op !== 'set' && !facts.multi) {
      problems.push(`${key} holds one value; use set`);
      return;
    }
    const isChoice = def.kind === 'select' || def.kind === 'multiselect' || def.kind === 'status';
    const choices = isChoice ? choicesFor(def, type) : null;
    const ghosts: string[] = [];
    let bad = false;
    const normalize = (item: unknown): unknown => {
      if (typeof item !== 'string') return item;
      if (choices !== null) {
        const hit = matchChoice(choices.list, item);
        if (hit !== null) return hit.id;
        const ghost = item.trim();
        if (op !== 'remove' && !ghosts.includes(ghost)) ghosts.push(ghost);
        return ghost;
      }
      if (facts.links) {
        const link = linkValue(item);
        if (link !== null) return link;
        bad = true;
        problems.push(`${key} takes page names or [[links]], one per value; "${item}" is neither`);
        return item;
      }
      return item;
    };
    let line: Line;
    let change: Change;
    let checked: unknown[];
    if (op === 'set' && value === null) {
      ({ line, change } = replace(key, value, null));
      checked = [];
    } else if (op === 'set' && facts.multi) {
      const list: unknown[] = [];
      for (const raw of itemsOf(value)) {
        const item = normalize(raw);
        if (!list.some((h) => same(facts.links, h, item))) list.push(item);
      }
      checked = [...list];
      ({ line, change } = replace(key, value, list));
    } else if (op === 'set') {
      const stored = Array.isArray(value) ? value.map(normalize) : normalize(value);
      checked = itemsOf(stored);
      ({ line, change } = replace(key, value, stored));
    } else {
      const items = itemsOf(value).map(normalize);
      const out = delta(op, key, items, facts.links);
      line = out.line;
      change = out.change;
      checked = out.added;
    }
    if (bad) return;
    if (choices !== null)
      for (const ghost of ghosts) line.clauses.push(ghostClause(ghost, choices));
    if (facts.links && def.target !== undefined) {
      for (const item of checked) {
        if (typeof item !== 'string') continue;
        const found = links.resolveLink(targetOf(item))?.entry ?? null;
        const page = found !== null && ctx.mayRead(found.path) ? found : null;
        if (page === null) {
          line.clauses.push(`${item} not checked: no page you can read answers to it`);
        } else if (page.type === null) {
          problems.push(`${key} takes ${def.target} records; ${item} has no type`);
        } else if (page.type !== def.target) {
          problems.push(`${key} takes ${def.target} records; ${item} is typed ${page.type}`);
        }
      }
    }
    if (change !== undefined && change !== null) {
      const problem = validateValue(def, change);
      if (problem !== null) {
        problems.push(problem);
        return;
      }
    }
    finish(line, change);
  };

  const ops: [Op, Fields][] = [
    ['set', req.set],
    ['add', req.add],
    ['remove', req.remove],
  ];
  for (const [op, map] of ops) {
    for (const [key, value] of Object.entries(map)) {
      if (key === 'type') {
        problems.push(TYPE_KEY_PROBLEM);
        continue;
      }
      if (declared === null) {
        undeclaredKey(op, key, value, null);
        continue;
      }
      const def = declared.fields.find((f) => f.name === key);
      if (def !== undefined) {
        declaredKey(op, key, value, def, declared);
        continue;
      }
      const wanted = normalizedKey(key);
      const near = declared.fields.find((f) => normalizedKey(f.name) === wanted);
      if (near !== undefined) {
        problems.push(`${key} is not a field of ${declared.name}; it declares ${near.name}`);
      } else {
        undeclaredKey(op, key, value, declared.name);
      }
    }
  }
  return problems.length > 0 ? { refused: problems } : { patch, notes };
}

/** An entry standing for the record as its bytes declare it, for the status
 * chain: its own type and project. */
function probeEntry(path: string, type: string, project: string | null): Entry {
  const cut = path.lastIndexOf('/');
  return {
    path,
    filename: path.slice(cut + 1),
    folder: cut === -1 ? '' : path.slice(0, cut),
    project,
    title: '',
    type,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '',
    modifiedAt: '',
    parseError: null,
    hash: null,
  };
}

/** What the model reads when the plan refused (Rust's `refusal_text`). */
export function setFieldsRefusal(path: string, problems: readonly string[]): string {
  return [`schema_invalid: nothing was written to ${path}.`, ...problems.map((p) => `- ${p}`)].join(
    '\n',
  );
}

/** What the model reads after a plan landed or changed nothing (Rust's
 * `report_text`). */
export function setFieldsReport(
  path: string,
  notes: readonly string[],
  hash: string,
  changed: boolean,
): string {
  const head = changed ? `Set fields on ${path}.` : `Nothing changed on ${path}.`;
  return [head, ...notes, `Hash: ${hash}`].join('\n');
}
