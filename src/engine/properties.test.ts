import { describe, expect, it } from 'vitest';
import {
  coerceValueToKind,
  computeRollup,
  formatTimestamp,
  findOptionByLabel,
  inferKindFromValue,
  moveOption,
  optionId,
  peopleTypes,
  personCandidates,
  relationTargetFor,
  isEmptyForVisibility,
  splitByVisibility,
  visibilityDelta,
  validatePatch,
  validateValue,
} from './properties';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { FieldDef } from './types';

const def = (kind: FieldDef['kind'], extra: Partial<FieldDef> = {}): FieldDef => ({
  name: 'field',
  kind,
  ...extra,
});

describe('validateValue (shape enforcement)', () => {
  it('null always passes (delete)', () => {
    expect(validateValue(def('number'), null)).toBeNull();
  });

  it('number rejects non-numbers', () => {
    expect(validateValue(def('number'), 3)).toBeNull();
    expect(validateValue(def('number'), 'abc')).toMatch(/number/);
    expect(validateValue(def('number'), Number.NaN)).toMatch(/number/);
  });

  it('checkbox wants booleans', () => {
    expect(validateValue(def('checkbox'), true)).toBeNull();
    expect(validateValue(def('checkbox'), 'yes')).toMatch(/on or off/);
  });

  it('date wants YYYY-MM-DD', () => {
    expect(validateValue(def('date'), '2026-07-26')).toBeNull();
    expect(validateValue(def('date'), '26/07/2026')).toMatch(/YYYY-MM-DD/);
  });

  it('daterange validates both endpoints', () => {
    expect(validateValue(def('daterange'), { start: '2026-07-01', end: null })).toBeNull();
    expect(validateValue(def('daterange'), { start: 'soon' })).toMatch(/YYYY-MM-DD/);
    expect(validateValue(def('daterange'), 'not-a-range')).toMatch(/range/);
  });

  it('select stays advisory on membership but strict on shape', () => {
    expect(validateValue(def('select'), 'anything')).toBeNull();
    expect(validateValue(def('select'), ['a', 'b'])).toMatch(/single option/);
  });

  it('multiselect accepts a string or string list', () => {
    expect(validateValue(def('multiselect'), ['a', 'b'])).toBeNull();
    expect(validateValue(def('multiselect'), 'a')).toBeNull();
    expect(validateValue(def('multiselect'), [1])).toMatch(/list/);
  });

  it('url wants a URL-looking string', () => {
    expect(validateValue(def('url'), 'https://cerebro.dev')).toBeNull();
    expect(validateValue(def('url'), 'www.cerebro.dev')).toBeNull();
    expect(validateValue(def('url'), 'not a url')).toMatch(/URL/);
  });

  it('files accepts string lists', () => {
    expect(validateValue(def('files'), ['a.png', 'docs/b.pdf'])).toBeNull();
    expect(validateValue(def('files'), 42)).toMatch(/files/);
  });

  it('computed kinds reject writes', () => {
    expect(validateValue(def('rollup'), 3)).toMatch(/computed/);
    expect(validateValue(def('created_time'), 'x')).toMatch(/computed/);
    expect(validateValue(def('last_edited_time'), 'x')).toMatch(/computed/);
  });

  // M12.4: enforced relations.
  it('relation honors limit: 1', () => {
    expect(validateValue(def('relation'), ['[[a]]'])).toBeNull();
    expect(validateValue(def('relation'), ['[[a]]', '[[b]]'])).toBeNull();
    expect(validateValue(def('relation', { limit: 1 }), '[[a]]')).toBeNull();
    expect(validateValue(def('relation', { limit: 1 }), ['[[a]]'])).toBeNull();
    expect(validateValue(def('relation', { limit: 1 }), ['[[a]]', '[[b]]'])).toMatch(/single/);
  });

  it('the derived side of a two-way relation rejects direct writes', () => {
    const derived = def('relation', { from: { type: 'Key result', field: 'objective' } });
    expect(validateValue(derived, ['[[kr-1]]'])).toMatch(/other side/);
  });
});

describe('validatePatch (schema-aware)', () => {
  const typeNote = makeEntry({
    path: 'types/task.md',
    title: 'Task',
    type: 'Type',
    properties: { fields: { effort: 'number', due: { kind: 'date' } } },
  });
  const doc = makeEntry({ path: 'a.md', type: 'Task' });
  const schema = buildSchema([typeNote, doc]);

  it('rejects declared fields with wrong shapes', () => {
    expect(validatePatch(schema, doc, { effort: 'lots' })).toHaveLength(1);
    expect(validatePatch(schema, doc, { effort: 5, due: '2026-08-01' })).toHaveLength(0);
  });

  it('undeclared keys pass (advisory schema)', () => {
    expect(validatePatch(schema, doc, { anything: { nested: true } })).toHaveLength(0);
  });

  it('untyped entries pass everything', () => {
    expect(validatePatch(schema, makeEntry({ type: null }), { effort: 'lots' })).toHaveLength(0);
  });
});

describe('computeRollup', () => {
  const subtasks = [
    makeEntry({ path: 'items/a.md', filename: 'a.md', title: 'A', properties: { estimate: 3 } }),
    makeEntry({ path: 'items/b.md', filename: 'b.md', title: 'B', properties: { estimate: 5 } }),
    makeEntry({ path: 'items/c.md', filename: 'c.md', title: 'C', properties: {} }),
  ];
  const parent = makeEntry({
    path: 'items/parent.md',
    relationships: { subtasks: ['a', 'b', 'c'] },
  });
  const entries = [parent, ...subtasks];

  it('counts related entries', () => {
    expect(computeRollup(parent, def('rollup', { relation: 'subtasks' }), entries)).toBe('3');
  });

  it('sums, averages, and bounds a numeric property', () => {
    const base = { relation: 'subtasks', property: 'estimate' } as const;
    expect(computeRollup(parent, def('rollup', { ...base, calculate: 'sum' }), entries)).toBe('8');
    expect(computeRollup(parent, def('rollup', { ...base, calculate: 'avg' }), entries)).toBe('4');
    expect(computeRollup(parent, def('rollup', { ...base, calculate: 'min' }), entries)).toBe('3');
    expect(computeRollup(parent, def('rollup', { ...base, calculate: 'max' }), entries)).toBe('5');
  });

  it('show lists the raw values', () => {
    expect(
      computeRollup(
        parent,
        def('rollup', { relation: 'subtasks', property: 'estimate', calculate: 'show' }),
        entries,
      ),
    ).toBe('3, 5');
  });

  it('empty relation → count 0, aggregates blank', () => {
    const lonely = makeEntry({ path: 'items/lonely.md' });
    expect(computeRollup(lonely, def('rollup', { relation: 'subtasks' }), entries)).toBe('0');
    expect(
      computeRollup(
        lonely,
        def('rollup', { relation: 'subtasks', property: 'estimate', calculate: 'sum' }),
        entries,
      ),
    ).toBe('');
  });
});

describe('formatTimestamp', () => {
  it('shows date and minutes', () => {
    expect(formatTimestamp('2026-07-24T09:30:12.000Z')).toBe('2026-07-24 09:30');
  });
});

// M12.4b: value conversion when a field changes kind.
describe('coerceValueToKind', () => {
  it('empty always clears', () => {
    expect(coerceValueToKind(null, 'number')).toBeNull();
    expect(coerceValueToKind('', 'text')).toBeNull();
  });

  it('to text joins lists', () => {
    expect(coerceValueToKind(['a', 'b'], 'text')).toBe('a, b');
    expect(coerceValueToKind(42, 'text')).toBe('42');
  });

  it('to number keeps a numeric reading and drops the rest', () => {
    expect(coerceValueToKind('42', 'number')).toBe(42);
    expect(coerceValueToKind('$1,200', 'number')).toBe(1200);
    expect(coerceValueToKind('high', 'number')).toBeNull();
  });

  it('to checkbox maps the usual spellings and drops prose', () => {
    expect(coerceValueToKind('yes', 'checkbox')).toBe(true);
    expect(coerceValueToKind('no', 'checkbox')).toBe(false);
    expect(coerceValueToKind(true, 'checkbox')).toBe(true);
    expect(coerceValueToKind('maybe', 'checkbox')).toBeNull();
  });

  it('to date keeps only real dates', () => {
    expect(coerceValueToKind('2026-07-30T10:00:00Z', 'date')).toBe('2026-07-30');
    expect(coerceValueToKind('next week', 'date')).toBeNull();
  });

  it('select vs multiselect: scalar vs list', () => {
    expect(coerceValueToKind(['a', 'b'], 'select')).toBe('a');
    expect(coerceValueToKind('a', 'multiselect')).toEqual(['a']);
  });

  it('to relation wraps names as wikilinks, splitting comma lists', () => {
    expect(coerceValueToKind('alpha, beta', 'relation')).toEqual(['[[alpha]]', '[[beta]]']);
    expect(coerceValueToKind(['[[gamma]]'], 'relation')).toEqual(['[[gamma]]']);
  });
});

/**
 * The kind icon an undeclared key gets (M16.6). A loose key has no declared
 * kind and the row leads with one, so the shape of the stored value is the
 * only evidence — this pins what each shape claims.
 */
describe('inferKindFromValue', () => {
  it('reads scalars off their JS type', () => {
    expect(inferKindFromValue(true)).toBe('checkbox');
    expect(inferKindFromValue(42)).toBe('number');
    expect(inferKindFromValue('just words')).toBe('text');
  });

  it('recognises the string shapes that are not prose', () => {
    expect(inferKindFromValue('2026-08-02')).toBe('date');
    expect(inferKindFromValue('https://example.com')).toBe('url');
    // Not a date: a partial one has no honest calendar reading.
    expect(inferKindFromValue('2026-08')).toBe('text');
  });

  // M16.13: an address used to infer as `url`, because URL_SHAPE accepts
  // `mailto:` — which was the nearest thing to an Email kind before there
  // was one. Email is the more specific answer, so it is checked first.
  it('prefers email over url for an address', () => {
    expect(inferKindFromValue('ada@example.com')).toBe('email');
    expect(inferKindFromValue('mailto:ada@example.com')).toBe('email');
    expect(inferKindFromValue('https://example.com/a@b')).toBe('url');
  });

  it('calls a list multi-select rather than text', () => {
    expect(inferKindFromValue(['work', 'urgent'])).toBe('multiselect');
    expect(inferKindFromValue([])).toBe('multiselect');
  });

  // The documented leftover: a daterange outlives the field that declared it,
  // and String(value) used to render it "[object Object]".
  it('recognises a start/end mapping, and only that mapping', () => {
    expect(inferKindFromValue({ start: '2026-01-01', end: null })).toBe('daterange');
    expect(inferKindFromValue({ owner: 'ada' })).toBe('text');
  });

  it('falls back to text for nothing at all', () => {
    expect(inferKindFromValue(null)).toBe('text');
    expect(inferKindFromValue(undefined)).toBe('text');
  });
});

/**
 * Per-property visibility (M16.10). Notion's three states are on the
 * PROPERTY, not on a view: `ColumnSpec.hidden` answers "does this view show
 * this column", and a record panel has no view to read it from.
 */
describe('splitByVisibility', () => {
  const f = (name: string, visibility?: 'show' | 'hide_when_empty' | 'hide'): FieldDef => ({
    name,
    kind: 'text',
    ...(visibility === undefined ? {} : { visibility }),
  });

  it('shows everything a vault that predates the model declares', () => {
    const { shown, hidden } = splitByVisibility([f('a'), f('b')], () => true);
    expect(shown.map((x) => x.name)).toEqual(['a', 'b']);
    expect(hidden).toEqual([]);
  });

  it('folds an always-hidden property whether or not it has a value', () => {
    const { shown, hidden } = splitByVisibility([f('a', 'hide'), f('b')], () => false);
    expect(shown.map((x) => x.name)).toEqual(['b']);
    expect(hidden.map((x) => x.name)).toEqual(['a']);
  });

  it('folds hide-when-empty only while it is empty', () => {
    const fields = [f('filled', 'hide_when_empty'), f('blank', 'hide_when_empty')];
    const { shown, hidden } = splitByVisibility(fields, (d) => d.name === 'blank');
    expect(shown.map((x) => x.name)).toEqual(['filled']);
    expect(hidden.map((x) => x.name)).toEqual(['blank']);
  });

  it('keeps declaration order inside each half', () => {
    const { shown } = splitByVisibility([f('a'), f('b', 'hide'), f('c')], () => false);
    expect(shown.map((x) => x.name)).toEqual(['a', 'c']);
  });
});

describe('isEmptyForVisibility', () => {
  it('treats a blank display as empty', () => {
    expect(isEmptyForVisibility({ name: 'a', kind: 'text' }, '')).toBe(true);
    expect(isEmptyForVisibility({ name: 'a', kind: 'text' }, 'x')).toBe(false);
  });

  // false is an answer, not a blank — hiding every unticked box would make
  // the state unreachable from the panel.
  it('never calls a checkbox empty', () => {
    expect(isEmptyForVisibility({ name: 'done', kind: 'checkbox' }, '')).toBe(false);
  });
});

/**
 * Dragging over a panel that is only showing SOME of the declared order.
 * Writing the visible index straight into the mapping would scatter the
 * hidden properties around it.
 */
describe('visibilityDelta', () => {
  const all = ['a', 'b', 'c', 'd'];

  it('is the plain delta when everything is visible', () => {
    expect(visibilityDelta(all, all, 'c', 0)).toBe(-2);
    expect(visibilityDelta(all, all, 'a', 3)).toBe(3);
  });

  // 'b' is hidden between 'a' and 'c'. Dropping 'd' at visible slot 1 puts it
  // immediately before 'c' — where the insertion line was drawn — so 'd' goes
  // to mapping index 2, not to the visible index 1 which would jump it past
  // the hidden 'b' as well.
  it('lands beside the visible neighbour, not at the visible index', () => {
    expect(visibilityDelta(all, ['a', 'c', 'd'], 'd', 1)).toBe(2 - 3);
  });

  it('leaves the hidden properties where they were', () => {
    const order = ['a', 'b', 'c', 'd'];
    const delta = visibilityDelta(order, ['a', 'c', 'd'], 'd', 1);
    const next = [...order];
    const [moved] = next.splice(order.indexOf('d'), 1);
    next.splice(order.indexOf('d') + delta, 0, moved);
    expect(next).toEqual(['a', 'b', 'd', 'c']);
    // 'b' is still between 'a' and the rest, exactly where it was hidden.
    expect(next.indexOf('b')).toBe(1);
  });

  it('past the last visible row lands after it', () => {
    expect(visibilityDelta(all, ['a', 'c'], 'a', 2)).toBe(2);
  });

  it('is a no-op for a name that is not declared', () => {
    expect(visibilityDelta(all, all, 'nope', 0)).toBe(0);
  });
});

/**
 * Option identity (M16.12). The inline-create row compared LABELS while the
 * id was a slug, so two labels that slug the same both got written.
 */
describe('option identity', () => {
  const opts = [
    { id: 'in-progress', label: 'In Progress' },
    { id: 'done', label: 'Done' },
  ];

  it('slugs a label the way the id is built', () => {
    expect(optionId('  In   Progress ')).toBe('in-progress');
    expect(optionId('Done')).toBe('done');
  });

  // The whole bug in one assertion.
  it('finds the collision a label comparison misses', () => {
    expect(findOptionByLabel(opts, 'In-Progress')?.id).toBe('in-progress');
    expect(findOptionByLabel(opts, 'in progress')?.id).toBe('in-progress');
    expect(opts.some((o) => o.label.toLowerCase() === 'in-progress')).toBe(false);
  });

  it('still catches a plain label match', () => {
    expect(findOptionByLabel(opts, 'done')?.id).toBe('done');
  });

  it('returns nothing for a genuinely new label', () => {
    expect(findOptionByLabel(opts, 'Blocked')).toBeUndefined();
  });
});

describe('moveOption', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('moves an item to a new index', () => {
    expect(moveOption(list, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveOption(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('returns the same array for a no-op or an out-of-range move', () => {
    expect(moveOption(list, 1, 1)).toBe(list);
    expect(moveOption(list, -1, 2)).toBe(list);
    expect(moveOption(list, 0, 9)).toBe(list);
  });

  it('does not mutate the input', () => {
    const copy = [...list];
    moveOption(list, 0, 3);
    expect(list).toEqual(copy);
  });
});

/**
 * Person is a relation with an avatar renderer (M16.13b).
 *
 * Three call sites answered "which records can this field point at?" with the
 * literal string 'Person' — the type-name routing AGENTS.md forbids. A vault
 * whose people are `Teammate`s got an empty picker, an empty rollup target,
 * and an @ menu with no people in it, with no control anywhere to fix any of
 * the three.
 */
describe('relation and person targets', () => {
  const vault = (people: string) => [
    makeEntry({ path: 'types/task.md', title: 'Task', type: 'Type' }),
    makeEntry({ path: `types/${people.toLowerCase()}.md`, title: people, type: 'Type' }),
    makeEntry({ path: 'people/ana.md', title: 'Ana', type: people }),
    makeEntry({ path: 'people/bo.md', title: 'Bo', type: people }),
    makeEntry({
      path: 'tasks/t1.md',
      title: 'T1',
      type: 'Task',
      relationships: { owner: ['ana'] },
    }),
  ];

  it('prefers a declared target over anything it could infer', () => {
    const entries = vault('Teammate');
    const d = def('person', { name: 'owner', target: 'Task' });
    expect(relationTargetFor(d, entries, 'Task')).toBe('Task');
  });

  it('infers a person target from the values already held', () => {
    const entries = vault('Teammate');
    const d = def('person', { name: 'owner' });
    expect(relationTargetFor(d, entries, 'Task')).toBe('Teammate');
  });

  // The old code answered 'Person' here regardless of what the vault holds.
  it('does not answer Person for a vault that has no Person type', () => {
    const entries = vault('Teammate');
    expect(entries.some((e) => e.type === 'Person')).toBe(false);
    expect(relationTargetFor(def('person', { name: 'owner' }), entries, 'Task')).toBe('Teammate');
  });

  // "Any record (unenforced)" is a choice RelationConfigEditor writes as a
  // deleted key. Inferring over it would silently re-enforce it.
  it('leaves an unenforced relation unenforced', () => {
    const entries = vault('Teammate');
    expect(relationTargetFor(def('relation', { name: 'owner' }), entries, 'Task')).toBeNull();
  });

  it('reads the derived side of a two-way pair off its owner', () => {
    const d = def('relation', { name: 'tasks', from: { type: 'Task', field: 'owner' } });
    expect(relationTargetFor(d, [], null)).toBe('Task');
  });

  // A field name is not unique across types: two types can both declare
  // `owner` and point them at different things.
  it('scopes value inference to the declaring type', () => {
    const entries = [
      ...vault('Teammate'),
      makeEntry({ path: 'types/bug.md', title: 'Bug', type: 'Type' }),
      makeEntry({ path: 'vendors/acme.md', title: 'Acme', type: 'Vendor' }),
      makeEntry({
        path: 'bugs/b1.md',
        title: 'B1',
        type: 'Bug',
        relationships: { owner: ['acme', 'acme'] },
      }),
    ];
    expect(relationTargetFor(def('person', { name: 'owner' }), entries, 'Task')).toBe('Teammate');
    expect(relationTargetFor(def('person', { name: 'owner' }), entries, 'Bug')).toBe('Vendor');
  });
});

describe('peopleTypes', () => {
  it('is every type a person field points at, however it is named', () => {
    const entries = [
      makeEntry({
        path: 'types/task.md',
        title: 'Task',
        type: 'Type',
        properties: { fields: { owner: { kind: 'person', target: 'Teammate' } } },
      }),
      makeEntry({ path: 'types/teammate.md', title: 'Teammate', type: 'Type' }),
    ];
    expect([...peopleTypes(buildSchema(entries), entries)]).toEqual(['Teammate']);
  });

  // A convention of last resort, so a vault with people but no person field
  // declared anywhere still gets a useful @ menu.
  it('falls back to a type literally named Person', () => {
    const entries = [makeEntry({ path: 'types/person.md', title: 'Person', type: 'Type' })];
    expect([...peopleTypes(buildSchema(entries), entries)]).toEqual(['Person']);
  });

  // An empty set is a real answer: surfaces drop their People section rather
  // than offering every record in the vault as a person.
  it('is empty for a vault with no notion of people', () => {
    const entries = [makeEntry({ path: 'types/task.md', title: 'Task', type: 'Type' })];
    expect(peopleTypes(buildSchema(entries), entries).size).toBe(0);
  });
});

describe('personCandidates', () => {
  const typeDocs = [
    makeEntry({
      path: 'types/task.md',
      title: 'Task',
      type: 'Type',
      properties: { fields: { owner: { kind: 'person', target: 'Teammate' } } },
    }),
    makeEntry({ path: 'types/teammate.md', title: 'Teammate', type: 'Type' }),
  ];
  const entries = [
    ...typeDocs,
    makeEntry({ path: 'people/ana.md', title: 'Ana', type: 'Teammate' }),
    makeEntry({ path: 'tasks/t1.md', title: 'T1', type: 'Task' }),
  ];
  const schema = buildSchema(entries);

  it('offers records of the declared target', () => {
    const got = personCandidates(
      def('person', { name: 'owner', target: 'Teammate' }),
      schema,
      entries,
      'Task',
    );
    expect(got.map((e) => e.title)).toEqual(['Ana']);
  });

  it('falls back to the vault’s people when the field names no target', () => {
    const got = personCandidates(def('person', { name: 'lead' }), schema, entries, 'Task');
    expect(got.map((e) => e.title)).toEqual(['Ana']);
  });

  // A long picker is merely long. The empty one this used to produce was a
  // dead end with no way out of it.
  it('offers every record rather than nothing when the vault has no people', () => {
    const bare = [
      makeEntry({ path: 'types/task.md', title: 'Task', type: 'Type' }),
      makeEntry({ path: 'tasks/t1.md', title: 'T1', type: 'Task' }),
    ];
    const got = personCandidates(def('person', { name: 'lead' }), buildSchema(bare), bare, 'Task');
    // Type docs are schema, never candidates.
    expect(got.map((e) => e.title)).toEqual(['T1']);
  });
});
