import { deepEqual } from '@/lib/deepEqual';
import { parseViewList } from './views';
import type { ViewDefinition } from './types';
/** A suggestion is checked data, never a write or a UI command. The shared
 * vocabulary and authored cases hold this reader to Rust's views.rs. */
import { kindFacts } from './fieldKindTable';
import { parseDateText } from './dateGrammar';
import { parseRelative } from './relativeDates';
import { VIRTUAL_FIELDS } from './schema';
import {
  declaredOptions,
  OPTION_KINDS,
  OPTION_OPS,
  recordsHoldKey,
  recordsHoldValue,
} from './viewCheck';
import { filterOpArity, filterOpsFor, numericText } from './viewFilters';
import {
  FILTER_OPS,
  type Entry,
  type FieldDef,
  type FilterGroup,
  type FilterOp,
  type Presentation,
  type Schema,
} from './types';
import { VIEW_VOCABULARY as V } from './viewVocabulary';

export interface ViewSuggestion {
  database: string;
  view: {
    name: string;
    filters?: FilterGroup;
    presentation: Pick<Presentation, 'type'> & Partial<Omit<Presentation, 'type'>>;
  };
  reasoning?: string;
}
export interface SuggestionProblem {
  path: string;
  message: string;
}
export type SuggestionCheck =
  | { ok: true; suggestion: ViewSuggestion }
  | { ok: false; kind: 'malformed' | 'refusal'; text: string; problems?: SuggestionProblem[] };
const NOTE =
  'The user sees this view as a card with a live preview. Nothing is written unless they add it.';
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const scalar = (v: unknown): boolean =>
  (typeof v === 'string' && v.trim() !== '') ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v));
const chars = (s: string): number => Array.from(s).length;
const spelling = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const compare = (a: string, b: string): number => {
  const aa = Array.from(a, (c) => c.codePointAt(0)!),
    bb = Array.from(b, (c) => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++)
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return aa.length - bb.length;
};

/** Case, punctuation, then bounded Damerau-Levenshtein. Suggestions never
 * substitute a name. The bounded rows prevent quadratic work on long names. */
export function closestName(wanted: string, names: readonly string[]): string | null {
  const lower = wanted.toLowerCase();
  const same = names.find((name) => name.toLowerCase() === lower);
  if (same !== undefined) return same;
  const normalized = spelling(wanted);
  const similar =
    normalized === '' ? undefined : names.find((name) => spelling(name) === normalized);
  if (similar !== undefined) return similar;
  const a = Array.from(lower),
    bound = a.length >= 8 ? 3 : 2;
  let best: { name: string; distance: number } | null = null;
  for (const name of names) {
    const b = Array.from(name.toLowerCase());
    if (Math.abs(a.length - b.length) > bound) continue;
    let previous = new Map(Array.from({ length: Math.min(b.length, bound) + 1 }, (_, j) => [j, j]));
    let before = new Map<number, number>();
    for (let i = 1; i <= a.length; i++) {
      const row = new Map<number, number>();
      if (i <= bound) row.set(0, i);
      for (let j = Math.max(1, i - bound); j <= Math.min(b.length, i + bound); j++) {
        let distance = Math.min(
          (previous.get(j) ?? bound + 1) + 1,
          (row.get(j - 1) ?? bound + 1) + 1,
          (previous.get(j - 1) ?? bound + 1) + Number(a[i - 1] !== b[j - 1]),
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
          distance = Math.min(distance, (before.get(j - 2) ?? bound + 1) + 1);
        row.set(j, distance);
      }
      before = previous;
      previous = row;
      if ([...row.values()].every((n) => n > bound)) break;
    }
    const distance = previous.get(b.length) ?? bound + 1;
    if (
      distance <= bound &&
      (best === null ||
        distance < best.distance ||
        (distance === best.distance && compare(name, best.name) < 0))
    )
      best = { name, distance };
  }
  return best?.name ?? null;
}
const words = (names: readonly string[]): string =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
const bounded = (names: readonly string[]): string =>
  names.slice(0, V.limits.names_listed).join(', ') +
  (names.length > V.limits.names_listed ? ` and ${names.length - V.limits.names_listed} more` : '');
const shown = (v: unknown): string => JSON.stringify(v) ?? 'null';

export function refusalText(database: string, problems: readonly SuggestionProblem[]): string {
  const lines = problems.slice(0, V.limits.problems).map((p) => `- ${p.path}: ${p.message}`);
  if (problems.length > V.limits.problems)
    lines.push(`- and ${problems.length - V.limits.problems} more.`);
  return [
    `schema_invalid: this view of ${database} can't be shown, so no card was made.`,
    ...lines,
  ].join('\n');
}
export function answerText(suggestion: ViewSuggestion): string {
  return JSON.stringify({ suggested: suggestion, note: NOTE });
}

function canonical(p: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(p, key))
      .map((key) => {
        const v = p[key];
        const rowKeys =
          key === 'group'
            ? V.keys.group
            : key === 'sort'
              ? V.keys.sort
              : key === 'columns'
                ? V.keys.column
                : null;
        return [
          key,
          rowKeys !== null && Array.isArray(v)
            ? v.map((row) => canonical(row as Record<string, unknown>, rowKeys))
            : key === 'chart' && object(v)
              ? canonical(v, V.keys.chart)
              : key === 'gallery' && object(v)
                ? canonical(v, V.keys.gallery)
                : v,
        ];
      }),
  );
}

export function checkSuggestion(
  args: unknown,
  schema: Schema,
  entries: readonly Entry[],
): SuggestionCheck {
  const malformed = (text: string): SuggestionCheck => ({ ok: false, kind: 'malformed', text });
  if (!object(args)) return malformed('suggest_view needs an object');
  let encoded: string;
  try {
    encoded = JSON.stringify(args);
  } catch {
    return malformed('suggest_view needs an object');
  }
  if (
    Array.from(encoded).reduce(
      (bytes, c) =>
        bytes +
        (c.codePointAt(0)! <= 0x7f
          ? 1
          : c.codePointAt(0)! <= 0x7ff
            ? 2
            : c.codePointAt(0)! <= 0xffff
              ? 3
              : 4),
      0,
    ) > V.limits.args_bytes
  )
    return malformed(`suggest_view takes at most ${V.limits.args_bytes} bytes`);
  if (typeof args.database !== 'string' || args.database.trim() === '')
    return malformed("suggest_view needs database: the database's name");
  if (!object(args.view)) return malformed('suggest_view needs view: an object');
  if (
    Object.hasOwn(args, 'reasoning') &&
    (typeof args.reasoning !== 'string' || chars(args.reasoning) > V.limits.reasoning)
  )
    return malformed(`reasoning must be a string of at most ${V.limits.reasoning} characters`);
  const docs = entries.filter((e) => e.type === 'Type' && e.parseError === null);
  const wanted = args.database.trim();
  const doc =
    docs.find((e) => e.title === wanted) ??
    docs.find((e) => e.title.toLowerCase() === wanted.toLowerCase());
  if (doc === undefined) {
    const broken = entries.find(
      (e) =>
        e.path.startsWith('types/') &&
        e.parseError !== null &&
        e.title.toLowerCase() === wanted.toLowerCase(),
    );
    if (broken !== undefined)
      return {
        ok: false,
        kind: 'refusal',
        text: `schema_invalid: ${broken.title}'s Type doc has YAML errors, so its fields can't be checked.`,
      };
    const names = [...new Set(docs.map((e) => e.title))].sort(compare),
      closest = closestName(args.database, names);
    return {
      ok: false,
      kind: 'refusal',
      text: `schema_invalid: type: no note this run can read has type "${args.database}".${closest === null ? '' : ` Closest: "${closest}".`} Types in use: ${names.join(', ')}`,
    };
  }
  const database = doc.title,
    view = args.view;
  const hidden = (name: string) =>
    database === 'Agent' && ['recent', 'memory', 'preferences'].includes(name);
  const defs = (schema.types.get(database)?.fields ?? []).filter((def) => !hidden(def.name));
  const records = entries.filter(
    (e) =>
      e.type === database && !e.path.startsWith('templates/') && !e.path.startsWith('knowledge/'),
  );
  const names = [
    ...new Set(
      [
        ...defs.map((d) => d.name),
        ...VIRTUAL_FIELDS,
        ...new Set(
          records.flatMap((e) => [...Object.keys(e.properties), ...Object.keys(e.relationships)]),
        ).values(),
      ].filter((name) => name !== 'type' && !hidden(name)),
    ),
  ];
  // Virtual type is included at its artifact position; held keys follow by code point.
  const declared = [...new Set([...defs.map((d) => d.name), ...VIRTUAL_FIELDS])];
  const allNames = [...declared, ...names.filter((name) => !declared.includes(name)).sort(compare)];
  const definition = (name: string): FieldDef | undefined =>
    hidden(name)
      ? undefined
      : name === 'title' || name === 'type'
        ? { name, kind: 'text' }
        : name === 'createdAt'
          ? { name, kind: 'created_time' }
          : name === 'modifiedAt'
            ? { name, kind: 'last_edited_time' }
            : (defs.find((d) => d.name === name) ??
              (recordsHoldKey(records, name) ? { name, kind: 'text' } : undefined));
  const problems: SuggestionProblem[] = [];
  const add = (path: string, message: string) => {
    problems.push({ path, message });
  };
  const enumAt = (path: string, value: unknown, values: readonly string[]) => {
    if (typeof value !== 'string' || !values.includes(value))
      add(path, `${shown(value)} is not one of ${words(values)}.`);
  };
  const fieldAt = (path: string, value: unknown, slot?: string): FieldDef | undefined => {
    if (typeof value !== 'string' || value === '') {
      add(path, 'expected a field name');
      return undefined;
    }
    const def = definition(value);
    if (def === undefined) {
      const close = closestName(value, allNames);
      add(
        path,
        `${database} has no field "${value}". ${close === null ? `Its fields: ${bounded(allNames)}.` : `Did you mean "${close}"?`}`,
      );
      return undefined;
    }
    if (slot !== undefined) {
      const rule = V.slots[slot];
      const fits = (d: FieldDef) =>
        rule.fact != null
          ? (kindFacts(d.kind) as unknown as Record<string, unknown>)[rule.fact] === true
          : kindFacts(d.kind).filters === rule.family;
      if (!fits(def)) {
        const options = allNames.filter((name) => {
          const d = definition(name);
          return d !== undefined && fits(d);
        });
        add(
          path,
          `${value}, a ${def.kind} field, can't ${rule.verb}. ${options.length === 0 ? `None of ${database}'s fields can.` : `Fields that can: ${bounded(options)}.`}`,
        );
      }
    }
    return def;
  };
  const unknownKeys = (
    value: Record<string, unknown>,
    allowed: readonly string[],
    path: string,
  ) => {
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) add(`${path}.${key}`, `leave "${key}" out.`);
  };
  for (const key of Object.keys(view))
    if (!V.keys.view.includes(key))
      add(key, `a suggested view takes name, filters and presentation; leave "${key}" out.`);
  const name = typeof view.name === 'string' ? view.name.trim() : '';
  if (name === '' || chars(name) > V.limits.name || /[\r\n]/.test(name))
    add('name', `a view needs a name of 1 to ${V.limits.name} characters on one line.`);
  let count = 0;
  const filter = (raw: unknown, path: string, depth: number, groupOnly = false): void => {
    if (!object(raw)) {
      add(path, 'expected {"all": [...]} or {"any": [...]}');
      return;
    }
    if ('all' in raw || 'any' in raw || groupOnly) {
      const key = 'all' in raw ? 'all' : 'any';
      if (Object.keys(raw).length !== 1 || !Array.isArray(raw[key])) {
        add(path, 'expected {"all": [...]} or {"any": [...]}');
        return;
      }
      if (depth > V.limits.filter_depth) {
        add('filters', `at most ${V.limits.filter_depth} levels of nested filters`);
        return;
      }
      raw[key].forEach((child, i) => filter(child, `${path}.${key}[${i}]`, depth + 1));
      return;
    }
    count++;
    if (Object.keys(raw).some((k) => !['field', 'op', 'value'].includes(k))) {
      add(path, 'expected {field, op, value?}');
      return;
    }
    if (typeof raw.field !== 'string' || raw.field === '') {
      add(`${path}.field`, 'expected a field name');
      return;
    }
    if (typeof raw.op !== 'string') {
      add(`${path}.op`, 'expected an operator name');
      return;
    }
    const def = fieldAt(path, raw.field);
    if (!(FILTER_OPS as readonly string[]).includes(raw.op)) {
      add(path, `"${raw.op}" is not an operator.`);
      return;
    }
    const op = raw.op as FilterOp;
    if (def !== undefined && !filterOpsFor(def.kind).includes(op)) {
      add(
        path,
        `"${op}" doesn't apply to ${raw.field}, a ${def.kind} field. It takes ${words(filterOpsFor(def.kind))}.`,
      );
      return;
    }
    const arity = filterOpArity(op),
      value = raw.value;
    const fits =
      arity === 'none'
        ? !Object.hasOwn(raw, 'value')
        : arity === 'one'
          ? scalar(value)
          : Array.isArray(value) &&
            (arity !== 'two' || value.length === 2) &&
            value.length > 0 &&
            value.every(scalar);
    if (!fits) {
      add(
        path,
        `${op} takes ${arity === 'none' ? 'no value' : arity === 'one' ? 'one value' : arity === 'two' ? 'two values, [low, high]' : 'a list of values'}`,
      );
      return;
    }
    if (def === undefined || arity === 'none') return;
    const values = Array.isArray(value) ? value : [value],
      family = kindFacts(def.kind).filters;
    const beforeValues = problems.length;
    for (const v of values) {
      if (
        family === 'number' &&
        !(typeof v === 'number' || (typeof v === 'string' && numericText(v) !== null))
      )
        add(path, `${raw.field} compares numbers, and ${shown(v)} is not a number`);
      if (
        family === 'date' &&
        !(typeof v === 'string' && (parseRelative(v) !== null || parseDateText(v) !== null))
      )
        add(
          path,
          `${raw.field} compares dates, and ${shown(v)} is not a date: use YYYY-MM-DD, YYYY-MM-DD HH:MM or a relative date such as today-7 or this_week`,
        );
      if (family === 'boolean' && typeof v !== 'boolean')
        add(path, `${raw.field} is a checkbox; use true or false`);
      if (OPTION_KINDS.has(def.kind) && OPTION_OPS.has(op)) {
        const options = [
          ...declaredOptions(schema, database, def),
          ...(kindFacts(def.kind).status_set ? records.flatMap((e) => schema.statusSetFor(e)) : []),
        ];
        const token = String(v),
          ids = [...new Set(options.map((o) => o.id))];
        if (!ids.includes(token) && !recordsHoldValue(records, raw.field, token)) {
          const label = options.find((o) => o.label === token),
            close = closestName(token, ids);
          add(
            path,
            label === undefined
              ? `${raw.field} has no option "${token}". ${close === null ? `Its options: ${bounded(ids)}.` : `Did you mean "${close}"?`}`
              : `"${token}" is the label of ${label.id}; filters take option ids, so use "${label.id}".`,
          );
        }
      }
    }
    if (
      op === 'is_between' &&
      problems.length === beforeValues &&
      !values.some((v) => parseRelative(v) !== null)
    ) {
      const [low, high] = values;
      const a = numericText(low),
        b = numericText(high);
      const da = typeof low === 'string' ? parseDateText(low) : null;
      const db = typeof high === 'string' ? parseDateText(high) : null;
      const reversed =
        family === 'date'
          ? da !== null &&
            db !== null &&
            `${da.date} ${da.time ?? '00:00'}` > `${db.date} ${db.time ?? '23:59'}`
          : a !== null && b !== null
            ? a > b
            : da !== null && db !== null
              ? `${da.date} ${da.time ?? '00:00'}` > `${db.date} ${db.time ?? '00:00'}`
              : String(low).toLowerCase() > String(high).toLowerCase();
      if (reversed)
        add(path, `is_between takes [low, high]; ${shown(low)} is after ${shown(high)}`);
    }
  };
  if (Object.hasOwn(view, 'filters')) {
    filter(view.filters, 'filters', 1, true);
    if (count > V.limits.filter_rules)
      add('filters', `at most ${V.limits.filter_rules} filter rules`);
  }
  const p = view.presentation;
  if (!object(p)) add('presentation', 'expected an object');
  else {
    const layout = V.view_types.find((row) => row.id === p.type);
    if (layout === undefined)
      enumAt(
        'presentation.type',
        p.type,
        V.view_types.map((row) => row.id),
      );
    else if (!layout.suggestable)
      add('presentation.type', `a ${layout.id} is built on its page by hand, not suggested.`);
    for (const key of Object.keys(p))
      if (!V.keys.presentation.includes(key))
        add(`presentation.${key}`, `"${key}" is set on the database's page, not suggested.`);
      else if (key !== 'type' && layout !== undefined && !layout.reads.includes(key))
        add(`presentation.${key}`, `a ${layout.id} doesn't read ${key}.`);
    if (layout?.suggestable)
      for (const key of V.keys.presentation) {
        if (!layout.reads.includes(key)) continue;
        const value = p[key],
          path = `presentation.${key}`;
        if (key === 'group' || key === 'sort' || key === 'columns') {
          if (value === undefined) {
            if (key === 'group' && layout.needs.includes('band'))
              add(path, 'a board needs a group level naming the field its columns band by.');
            continue;
          }
          if (!Array.isArray(value)) {
            add(path, 'expected an array');
            continue;
          }
          const max =
            key === 'group'
              ? V.limits.group_levels
              : key === 'sort'
                ? V.limits.sort_keys
                : V.limits.columns;
          if (value.length > max)
            add(
              path,
              `at most ${max} ${key === 'group' ? 'group levels' : key === 'sort' ? 'sort keys' : 'columns'}`,
            );
          if (key === 'group' && value.length === 0 && layout.needs.includes('band'))
            add(path, 'a board needs a group level naming the field its columns band by.');
          value.forEach((row, i) => {
            const at = `${path}[${i}]`;
            if (!object(row)) {
              add(at, 'expected an object');
              return;
            }
            unknownKeys(row, key === 'columns' ? V.keys.column : V.keys[key], at);
            const def = fieldAt(at, row.field, key === 'columns' ? undefined : key);
            if (Object.hasOwn(row, 'dir')) enumAt(`${at}.dir`, row.dir, V.directions);
            else if (key === 'sort') add(`${at}.dir`, 'expected asc or desc');
            if (
              key === 'group' &&
              Object.hasOwn(row, 'hideEmpty') &&
              typeof row.hideEmpty !== 'boolean'
            )
              add(`${at}.hideEmpty`, 'expected true or false');
            if (key === 'group' && Object.hasOwn(row, 'dateBucket')) {
              enumAt(`${at}.dateBucket`, row.dateBucket, V.date_buckets);
              if (def !== undefined && kindFacts(def.kind).filters !== V.slots.dateBucket.family)
                add(
                  `${at}.dateBucket`,
                  `dateBucket needs a date field; ${def.name} is a ${def.kind} field.`,
                );
            }
          });
        } else if (key === 'dateField') {
          if (value === undefined && layout.needs.includes('dateField'))
            add(path, `a ${layout.id} needs a dateField.`);
          else if (value !== undefined) fieldAt(path, value, 'dateField');
        } else if (key === 'calendarSpan' || key === 'zoom') {
          if (value !== undefined) enumAt(path, value, key === 'zoom' ? V.zooms : V.calendar_spans);
        } else if (key === 'limit' && value !== undefined) {
          if (
            typeof value !== 'number' ||
            !Number.isInteger(value) ||
            value < 1 ||
            value > V.limits.view_limit
          )
            add(path, `limit is a whole number from 1 to ${V.limits.view_limit}.`);
        } else if (key === 'gallery' && value !== undefined) {
          if (!object(value)) add(path, 'expected an object');
          else {
            unknownKeys(value, V.keys.gallery, path);
            if (value.cover !== undefined) fieldAt(`${path}.cover`, value.cover, 'gallery.cover');
          }
        } else if (key === 'chart') {
          if (!object(value) || value.kind === undefined) {
            add(path, 'a chart view needs chart.kind.');
            continue;
          }
          const chart = V.chart_kinds.find((row) => row.id === value.kind);
          if (chart === undefined) {
            enumAt(
              `${path}.kind`,
              value.kind,
              V.chart_kinds.map((row) => row.id),
            );
            continue;
          }
          for (const k of Object.keys(value))
            if (!V.keys.chart.includes(k)) add(`${path}.${k}`, `leave "${k}" out.`);
            else if (k !== 'kind' && !chart.reads.includes(k))
              add(`${path}.${k}`, `a ${chart.id} chart doesn't read ${k}.`);
          for (const k of V.keys.chart) {
            if (!chart.reads.includes(k)) continue;
            const v = value[k],
              at = `${path}.${k}`;
            if (k === 'agg' && v !== undefined) enumAt(at, v, V.chart_aggs);
            else if (k === 'sort' && v !== undefined) enumAt(at, v, V.chart_sorts);
            else if (k === 'value') {
              const agg = value.agg ?? 'count';
              if (V.measured_aggs.includes(String(agg)) && v === undefined)
                add(at, `${agg} needs a value field to measure.`);
              else if (agg === 'count' && v !== undefined)
                add(at, 'count measures no value; leave value out.');
              else if (v !== undefined) fieldAt(at, v, 'chart.value');
            } else if (k === 'xField' || k === 'groupBy') {
              if (v !== undefined) fieldAt(at, v, `chart.${k}`);
              else if (
                k === 'xField' &&
                chart.needs_axis &&
                (!Array.isArray(p.group) || p.group.length === 0)
              )
                add(at, `a ${chart.id} chart needs chart.xField or a group level.`);
            }
          }
        }
      }
  }
  if (problems.length > 0)
    return { ok: false, kind: 'refusal', text: refusalText(database, problems), problems };
  const suggestion: ViewSuggestion = {
    database,
    view: {
      name,
      ...(view.filters === undefined ? {} : { filters: view.filters as FilterGroup }),
      presentation: canonical(
        p as Record<string, unknown>,
        V.keys.presentation,
      ) as ViewSuggestion['view']['presentation'],
    },
    ...(args.reasoning === undefined ? {} : { reasoning: args.reasoning as string }),
  };
  return { ok: true, suggestion };
}

/** Validate the stored tool envelope before any component touches its arrays.
 * Field existence belongs to the current-schema check, not this historical read. */
function suggestionShape(value: Record<string, unknown>): boolean {
  if (
    Object.keys(value).some((k) => !['database', 'view', 'reasoning'].includes(k)) ||
    typeof value.database !== 'string' ||
    value.database.trim() === '' ||
    !object(value.view)
  )
    return false;
  if (
    value.reasoning !== undefined &&
    (typeof value.reasoning !== 'string' || chars(value.reasoning) > V.limits.reasoning)
  )
    return false;
  const view = value.view;
  if (
    Object.keys(view).some((k) => !V.keys.view.includes(k)) ||
    typeof view.name !== 'string' ||
    view.name.trim() === '' ||
    chars(view.name) > V.limits.name ||
    /[\r\n]/.test(view.name) ||
    !object(view.presentation)
  )
    return false;
  let rules = 0;
  const validFilter = (raw: unknown, depth: number, groupOnly = false): boolean => {
    if (!object(raw)) return false;
    if ('all' in raw || 'any' in raw || groupOnly) {
      const children = raw['all' in raw ? 'all' : 'any'];
      return (
        depth <= V.limits.filter_depth &&
        Object.keys(raw).length === 1 &&
        Array.isArray(children) &&
        children.every((child) => validFilter(child, depth + 1))
      );
    }
    if (
      ++rules > V.limits.filter_rules ||
      Object.keys(raw).some((k) => !['field', 'op', 'value'].includes(k)) ||
      typeof raw.field !== 'string' ||
      raw.field === '' ||
      !(FILTER_OPS as readonly unknown[]).includes(raw.op)
    )
      return false;
    const arity = filterOpArity(raw.op as FilterOp);
    return arity === 'none'
      ? !Object.hasOwn(raw, 'value')
      : arity === 'one'
        ? scalar(raw.value)
        : Array.isArray(raw.value) &&
          raw.value.length > 0 &&
          (arity !== 'two' || raw.value.length === 2) &&
          raw.value.every(scalar);
  };
  if (view.filters !== undefined && !validFilter(view.filters, 1, true)) return false;
  const p = view.presentation,
    layout = V.view_types.find((v) => v.id === p.type && v.suggestable);
  if (layout === undefined || Object.keys(p).some((k) => k !== 'type' && !layout.reads.includes(k)))
    return false;
  const field = (v: unknown) => typeof v === 'string' && v !== '';
  for (const key of ['group', 'sort', 'columns'] as const) {
    const rows = p[key];
    if (rows === undefined) continue;
    const max =
      key === 'group'
        ? V.limits.group_levels
        : key === 'sort'
          ? V.limits.sort_keys
          : V.limits.columns;
    const keys = key === 'columns' ? V.keys.column : V.keys[key];
    if (
      !Array.isArray(rows) ||
      rows.length > max ||
      !rows.every(
        (row) =>
          object(row) &&
          Object.keys(row).every((k) => keys.includes(k)) &&
          field(row.field) &&
          (row.dir === undefined
            ? key !== 'sort'
            : typeof row.dir === 'string' && V.directions.includes(row.dir)) &&
          (row.hideEmpty === undefined || typeof row.hideEmpty === 'boolean') &&
          (row.dateBucket === undefined ||
            (typeof row.dateBucket === 'string' && V.date_buckets.includes(row.dateBucket))),
      )
    )
      return false;
  }
  if (layout.needs.includes('band') && (!Array.isArray(p.group) || p.group.length === 0))
    return false;
  if (p.dateField !== undefined ? !field(p.dateField) : layout.needs.includes('dateField'))
    return false;
  if (
    p.calendarSpan !== undefined &&
    !(typeof p.calendarSpan === 'string' && V.calendar_spans.includes(p.calendarSpan))
  )
    return false;
  if (p.zoom !== undefined && !(typeof p.zoom === 'string' && V.zooms.includes(p.zoom)))
    return false;
  if (
    p.limit !== undefined &&
    (typeof p.limit !== 'number' ||
      !Number.isInteger(p.limit) ||
      p.limit < 1 ||
      p.limit > V.limits.view_limit)
  )
    return false;
  if (
    p.gallery !== undefined &&
    (!object(p.gallery) ||
      Object.keys(p.gallery).some((k) => !V.keys.gallery.includes(k)) ||
      (p.gallery.cover !== undefined && !field(p.gallery.cover)))
  )
    return false;
  if (p.chart !== undefined || layout.needs.includes('chart')) {
    if (!object(p.chart)) return false;
    const chart = p.chart,
      kind = V.chart_kinds.find((k) => k.id === chart.kind);
    if (
      kind === undefined ||
      Object.keys(chart).some((k) => k !== 'kind' && !kind.reads.includes(k))
    )
      return false;
    if (
      chart.agg !== undefined &&
      !(typeof chart.agg === 'string' && V.chart_aggs.includes(chart.agg))
    )
      return false;
    if (
      chart.sort !== undefined &&
      !(typeof chart.sort === 'string' && V.chart_sorts.includes(chart.sort))
    )
      return false;
    if (['value', 'xField', 'groupBy'].some((k) => chart[k] !== undefined && !field(chart[k])))
      return false;
    const agg = chart.agg ?? 'count';
    if (
      (V.measured_aggs.includes(String(agg)) && chart.value === undefined) ||
      (agg === 'count' && chart.value !== undefined)
    )
      return false;
    if (
      kind.needs_axis &&
      chart.xField === undefined &&
      (!Array.isArray(p.group) || p.group.length === 0)
    )
      return false;
  }
  return true;
}

/** Only a successful tool answer can create a card. Shape is checked without
 * pretending an old schema snapshot still applies; the card rechecks live. */
export function parseSuggestionResult(output: string | null): ViewSuggestion | null {
  if (output === null) return null;
  try {
    const data: unknown = JSON.parse(output);
    if (!object(data) || data.note !== NOTE || !object(data.suggested)) return null;
    const s = data.suggested;
    if (!suggestionShape(s)) return null;
    return s as unknown as ViewSuggestion;
  } catch {
    return null;
  }
}

/** Fill the app's standard saved-view defaults only when consuming a checked
 * suggestion. IDs remain placeholders until the action mints a free one. */
export function completeSuggestion(suggestion: ViewSuggestion): ViewDefinition {
  return parseViewList([{ id: 'suggested', ...suggestion.view }])[0];
}

export function sameView(a: ViewDefinition, b: ViewDefinition): boolean {
  return deepEqual(a.filters, b.filters) && deepEqual(a.presentation, b.presentation);
}

export function suggestedViewName(name: string, takenNames: readonly string[]): string {
  const taken = new Set(takenNames.map((value) => value.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  let index = 2;
  while (taken.has(`${name} ${index}`.toLowerCase())) index++;
  return `${name} ${index}`;
}
