import { describe, expect, it } from 'vitest';
import {
  CASTS,
  castRule,
  convertValue,
  dryRunKindChange,
  kindChangeHint,
  kindChangeMenu,
  neverReason,
  newPropertyName,
  stripMisfitTests,
  type ConvertCtx,
  type KindChangeCtx,
  type KindChangePreview,
} from './castRules';
import { buildSchema } from './schema';
import { makeEntry } from '@/test/factories';
import { FIELD_KINDS } from './types';
import type { Entry, FieldKind, ListFile, ViewDefinition } from './types';

/**
 * The cast table, pinned row by row (M60.5, Appendix C). Columns in
 * FIELD_KINDS order; the diagonal is S by `castRule` whatever the row says.
 */
const EXPECTED: Record<FieldKind, string> = {
  text: 'S C C C C S S C C C C S S N N N N',
  number: 'S S N N N S S C N N N N S N N N N',
  checkbox: 'S N S N N N N N N N N N N N N N N',
  date: 'S N N S S N N N N N N N N N N N N',
  daterange: 'S N N C S N N N N N N N N N N N N',
  select: 'S C C C N S S C C C C S S N N N N',
  multiselect: 'S C C C N C S C C C C C C N N N N',
  status: 'S N N N N S S S N N N N N N N N N',
  person: 'N N N N N N N N S S N N N N N N N',
  relation: 'N N N N N N N N S S N N N N N N N',
  url: 'S N N N N S S C N N S S S N N N N',
  email: 'S C C C C S S C C C C S S N N N N',
  phone: 'S C C C C S S C C C C S S N N N N',
  files: 'S N N N N N N N N N N N N S N N N',
  rollup: 'S C C C C S S C C C C S S N S N N',
  created_time: 'S C C C C S S C C C C S S N N S N',
  last_edited_time: 'S C C C C S S C C C C S S N N N S',
};
const LETTER = { safe: 'S', checked: 'C', never: 'N' } as const;

describe('the cast table', () => {
  for (const from of FIELD_KINDS) {
    it(`pins the ${from} row`, () => {
      const row = FIELD_KINDS.map((to) => LETTER[castRule(from, to, true)]).join(' ');
      expect(row).toBe(EXPECTED[from]);
      expect(CASTS[from]).toBe(EXPECTED[from].replace(/ /g, ''));
    });
  }

  it('is safe for an empty field into every stored kind, and never into a computed one', () => {
    for (const from of FIELD_KINDS) {
      for (const to of FIELD_KINDS) {
        if (from === to) continue;
        const computed = to === 'rollup' || to === 'created_time' || to === 'last_edited_time';
        expect(castRule(from, to, false)).toBe(computed ? 'never' : 'safe');
      }
    }
  });

  it('generates each Never reason from its row', () => {
    expect(neverReason('status')).toBe('Status can become only Text, Select or Multi-select.');
    expect(neverReason('person')).toBe('Person can become only Relation.');
    expect(neverReason('checkbox')).toBe('Checkbox can become only Text.');
    expect(neverReason('files')).toBe('Files & media can become only Text.');
    expect(neverReason('date')).toBe('Date can become only Text.');
  });
});

// --- converters -------------------------------------------------------------

const ana = makeEntry({ path: 'people/ana-rios.md', title: 'Ana Rios', type: 'Person' });

/** A one-record vault whose `Thing` type declares `f` as `from`. */
function ctxFor(from: FieldKind, value: unknown): { raw: unknown; ctx: ConvertCtx } {
  const spec: Record<string, unknown> = { kind: from };
  if (from === 'select' || from === 'multiselect') {
    spec.options = [
      { id: 'high', label: 'High!', color: '#DE8F0A' },
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
  }
  const doc = makeEntry({
    path: 'types/thing.md',
    title: 'Thing',
    type: 'Type',
    properties: {
      statuses: [
        { id: 'todo', group: 'active' },
        { id: 'doing', group: 'active', label: 'In flight' },
      ],
      fields: { f: spec },
    } as unknown as Entry['properties'],
  });
  const links = from === 'person' || from === 'relation';
  const record = makeEntry({
    path: 'things/one.md',
    title: 'One',
    type: 'Thing',
    properties: links ? {} : ({ f: value } as Entry['properties']),
    relationships: links ? { f: (value as string[]).map((v) => v.slice(2, -2)) } : {},
  });
  const entries = [doc, record, ana];
  const schema = buildSchema(entries);
  const def = schema.types.get('Thing')!.fields.find((d) => d.name === 'f')!;
  return { raw: value, ctx: { from, field: 'f', record, schema, entries, def } };
}

const convert = (from: FieldKind, value: unknown, to: FieldKind) => {
  const { raw, ctx } = ctxFor(from, value);
  return convertValue(raw, to, ctx);
};

/** A value valid for each stored kind. */
const SAMPLES: Partial<Record<FieldKind, unknown>> = {
  text: 'hello',
  number: 12,
  checkbox: true,
  date: '2026-07-28',
  daterange: { start: '2026-07-28', end: '2026-08-02' },
  select: 'high',
  multiselect: ['a'],
  status: 'todo',
  person: ['[[ana-rios]]'],
  relation: ['[[ana-rios]]'],
  url: 'https://example.com',
  email: 'a@b.co',
  phone: '+1 555 0100',
  files: ['cover.png'],
};

describe('convertValue', () => {
  it('converts a sample of every source through every Safe cell', () => {
    for (const [from, sample] of Object.entries(SAMPLES) as [FieldKind, unknown][]) {
      for (const to of FIELD_KINDS) {
        if (to === from || castRule(from, to, true) !== 'safe') continue;
        expect({ from, to, out: convert(from, sample, to).ok }).toEqual({ from, to, out: true });
      }
    }
  });

  it('reads numbers strictly', () => {
    expect(convert('text', '12', 'number')).toEqual({ ok: true, value: 12 });
    expect(convert('text', '-3.5', 'number')).toEqual({ ok: true, value: -3.5 });
    expect(convert('text', ' 7 ', 'number')).toEqual({ ok: true, value: 7 });
    for (const bad of ['007', '1,200', '$5', '1e3', 'v2', 'n/a']) {
      expect(convert('text', bad, 'number').ok).toBe(false);
    }
  });

  it('reads checkbox words, ignoring case', () => {
    for (const yes of ['yes', 'TRUE', 'x', 'On', '1']) {
      expect(convert('text', yes, 'checkbox')).toEqual({ ok: true, value: true });
    }
    for (const no of ['no', 'False', 'off', '0']) {
      expect(convert('text', no, 'checkbox')).toEqual({ ok: true, value: false });
    }
    expect(convert('text', 'maybe', 'checkbox').ok).toBe(false);
  });

  it('reads dates by the shared grammar, and a range only without a distinct end', () => {
    expect(convert('text', '2026-07-28', 'date')).toEqual({ ok: true, value: '2026-07-28' });
    expect(convert('text', '2026-07-28 kickoff', 'date').ok).toBe(false);
    expect(convert('text', '2026-02-30', 'date').ok).toBe(false);
    expect(convert('daterange', { start: '2026-07-28', end: null }, 'date')).toEqual({
      ok: true,
      value: '2026-07-28',
    });
    expect(convert('daterange', { start: '2026-07-28', end: '2026-08-02' }, 'date').ok).toBe(false);
  });

  it('splits text into a range on → -> .. and a comma', () => {
    for (const text of [
      '2026-08-02 → 2026-08-09',
      '2026-08-02->2026-08-09',
      '2026-08-02..2026-08-09',
      '2026-08-02, 2026-08-09',
    ]) {
      expect(convert('text', text, 'daterange')).toEqual({
        ok: true,
        value: { start: '2026-08-02', end: '2026-08-09' },
      });
    }
    expect(convert('date', '2026-08-02', 'daterange')).toEqual({
      ok: true,
      value: { start: '2026-08-02', end: null },
    });
    // Backwards ranges are refused on write (M60.3), so they do not convert.
    expect(convert('text', '2026-08-09 → 2026-08-02', 'daterange').ok).toBe(false);
    expect(convert('text', 'soon → later', 'daterange').ok).toBe(false);
  });

  it('writes what a cell shows into text: labels and Yes or No', () => {
    expect(convert('select', 'high', 'text')).toEqual({ ok: true, value: 'High!' });
    expect(convert('multiselect', ['a', 'b'], 'text')).toEqual({ ok: true, value: 'A, B' });
    expect(convert('status', 'doing', 'text')).toEqual({ ok: true, value: 'In flight' });
    expect(convert('checkbox', false, 'text')).toEqual({ ok: true, value: 'No' });
    expect(convert('daterange', { start: '2026-07-28', end: '2026-08-02' }, 'text')).toEqual({
      ok: true,
      value: '2026-07-28 → 2026-08-02',
    });
  });

  it('turns names that resolve into links, and refuses one that does not', () => {
    expect(convert('text', 'Ana Rios', 'person')).toEqual({ ok: true, value: ['[[Ana Rios]]'] });
    expect(convert('text', '[[ana-rios]], Ana Rios', 'relation')).toEqual({
      ok: true,
      value: ['[[ana-rios]]', '[[Ana Rios]]'],
    });
    expect(convert('text', 'Nobody Here', 'person').ok).toBe(false);
  });

  it('takes a multi-select only when it holds a single value', () => {
    expect(convert('multiselect', ['5'], 'number')).toEqual({ ok: true, value: 5 });
    expect(convert('multiselect', ['5', '6'], 'number').ok).toBe(false);
    expect(convert('multiselect', ['a@b.co'], 'email')).toEqual({ ok: true, value: 'a@b.co' });
    expect(convert('multiselect', ['a@b.co', 'c@d.co'], 'email').ok).toBe(false);
    expect(convert('multiselect', ['x'], 'select')).toEqual({ ok: true, value: 'x' });
    expect(convert('multiselect', ['x', 'y'], 'select').ok).toBe(false);
  });

  it('matches a status by id, slug or label', () => {
    expect(convert('text', 'doing', 'status')).toEqual({ ok: true, value: 'doing' });
    expect(convert('text', 'In flight', 'status')).toEqual({ ok: true, value: 'doing' });
    expect(convert('text', 'Todo', 'status')).toEqual({ ok: true, value: 'todo' });
    expect(convert('text', 'shipped', 'status').ok).toBe(false);
  });

  it('accepts only a URL with a scheme once a bare host is given one', () => {
    expect(convert('text', 'example.com/x', 'url')).toEqual({
      ok: true,
      value: 'https://example.com/x',
    });
    expect(convert('text', 'not a url', 'url').ok).toBe(false);
  });
});

// --- the dry run ------------------------------------------------------------

function betVault(
  stakes: (string | undefined)[],
  views: unknown[] = [],
): { entries: Entry[]; ctx: KindChangeCtx } {
  const doc = makeEntry({
    path: 'types/bet.md',
    title: 'Bet',
    type: 'Type',
    properties: {
      fields: { stake: { kind: 'text' }, odds: { kind: 'number' } },
      views,
    } as unknown as Entry['properties'],
  });
  const bets = stakes.map((stake, i) =>
    makeEntry({
      path: `bets/bet-${i + 1}.md`,
      title: `Bet ${i + 1}`,
      type: 'Bet',
      properties: (stake === undefined ? {} : { stake }) as Entry['properties'],
    }),
  );
  const entries = [doc, ...bets];
  const schema = buildSchema(entries);
  const def = schema.types.get('Bet')!.fields.find((f) => f.name === 'stake')!;
  return {
    entries,
    ctx: {
      typeName: 'Bet',
      field: 'stake',
      def,
      entries,
      schema,
      lists: [],
      reserved: new Set(['type', 'fields']),
    },
  };
}

describe('dryRunKindChange', () => {
  it('counts what converts and quotes up to three that do not', () => {
    const { ctx } = betVault(['12', 'abc', 'n/a', 'TBD', 'later', undefined]);
    const p = dryRunKindChange(ctx, 'number');
    expect(p).toMatchObject({
      cast: 'checked',
      holding: 5,
      converts: 1,
      failures: 4,
      examples: ['“abc”', '“n/a”', '“TBD”'],
      lossless: false,
      newName: 'stake_number',
    });
    // As a new property, every record that converts is written.
    expect(p.writes).toEqual([{ path: 'bets/bet-1.md', value: 12 }]);
  });

  it('cuts a long example at forty characters', () => {
    const long = 'x'.repeat(60);
    const p = dryRunKindChange(betVault(['1', long]).ctx, 'number');
    expect(p.examples).toEqual([`“${'x'.repeat(39)}…”`]);
  });

  it('writes in place only the values that change', () => {
    const p = dryRunKindChange(betVault(['12', 'big']).ctx, 'select');
    expect(p.lossless).toBe(true);
    expect(p.writes).toEqual([]);
    // Each option reads as the value it was seeded from: a bare id where its
    // label is the id humanized, else the label beside it.
    expect(p.options).toEqual(['12', { id: 'big', label: 'big' }]);
    const n = dryRunKindChange(betVault(['12', '7']).ctx, 'number');
    expect(n.writes).toEqual([
      { path: 'bets/bet-1.md', value: 12 },
      { path: 'bets/bet-2.md', value: 7 },
    ]);
  });

  it('is Never when every value fails', () => {
    const p = dryRunKindChange(betVault(['abc', 'TBD']).ctx, 'number');
    expect(p.cast).toBe('never');
    expect(p.reason).toBe('None of its 2 values can be read as Number.');
    expect(p.writes).toEqual([]);
  });

  it('is Never by the table, with the row as the reason', () => {
    const { ctx } = betVault(['12']);
    const p = dryRunKindChange({ ...ctx, def: { name: 'stake', kind: 'checkbox' } }, 'number');
    expect(p.cast).toBe('never');
    expect(p.reason).toBe('Checkbox can become only Text.');
  });

  const groupedByStake = [
    {
      id: 'board',
      name: 'Board',
      presentation: { type: 'board', group: [{ field: 'stake' }], sort: [], columns: [] },
    },
  ];

  it('blocks an in-place change to a kind that cannot group while a view groups by it', () => {
    const p = dryRunKindChange(betVault(['1', '2'], groupedByStake).ctx, 'number');
    expect(p.cast).toBe('never');
    expect(p.reason).toBe('A view groups by Stake; change its grouping first.');
    // A kind that groups is not blocked.
    expect(dryRunKindChange(betVault(['1', '2'], groupedByStake).ctx, 'select').cast).toBe('safe');
  });

  it('does not block Convert into a new property', () => {
    const p = dryRunKindChange(betVault(['1', 'two'], groupedByStake).ctx, 'number');
    expect(p.cast).toBe('checked');
    expect(p.lossless).toBe(false);
    expect(p.writes).toEqual([{ path: 'bets/bet-1.md', value: 1 }]);
  });

  it('counts the misfit filters it strips and the ones in List files over the type', () => {
    const views = [
      {
        id: 'some',
        name: 'Some',
        filters: { all: [{ field: 'stake', op: 'starts_with', value: '1' }] },
        presentation: { type: 'table', group: [], sort: [], columns: [] },
      },
    ];
    const { ctx } = betVault(['1'], views);
    const list = {
      id: 'bets',
      path: 'bets.list.yml',
      project: null,
      collection: null,
      definition: {
        name: 'Bets',
        icon: null,
        color: null,
        order: null,
        source: { type: 'Bet', project: null },
        views: [
          {
            id: 'v',
            name: 'V',
            icon: null,
            filters: { any: [{ field: 'stake', op: 'contains', value: '1' }] },
            presentation: { type: 'table', group: [], sort: [], columns: [] },
          },
        ],
      },
    } as unknown as ListFile;
    const p = dryRunKindChange({ ...ctx, lists: [list] }, 'number');
    expect(p.stripped).toBe(1);
    expect(p.flaggedElsewhere).toBe(1);
  });

  it('counts misfit filters elsewhere wherever a List view stores them, from viewRefs (M60.2)', () => {
    const { ctx } = betVault(['1']);
    const misfit = { field: 'stake', op: 'contains', value: '1' };
    const fits = { field: 'stake', op: 'equals', value: 1 };
    const list = {
      id: 'bets',
      path: 'bets.list.yml',
      project: null,
      collection: null,
      definition: {
        name: 'Bets',
        icon: null,
        color: null,
        order: null,
        source: { type: 'Bet', project: null },
        views: [
          {
            id: 'dash',
            name: 'Dash',
            icon: null,
            filters: { all: [fits, { any: [misfit] }] },
            presentation: {
              type: 'dashboard',
              group: [],
              sort: [],
              columns: [],
              dashboard: {
                global: { all: [misfit] },
                rows: [
                  { id: 'r', widgets: [{ id: 't', kind: 'table', filter: { any: [misfit] } }] },
                ],
              },
            },
          },
        ],
      },
    } as unknown as ListFile;
    expect(dryRunKindChange({ ...ctx, lists: [list] }, 'number').flaggedElsewhere).toBe(3);
  });

  it('names the new property clear of fields, record keys and reserved keys', () => {
    const { ctx } = betVault(['1', 'x']);
    const taken = makeEntry({
      path: 'bets/bet-9.md',
      type: 'Bet',
      properties: { stake_number: 3 } as Entry['properties'],
    });
    const entries = [...ctx.entries, taken];
    const p = dryRunKindChange({ ...ctx, entries, schema: buildSchema(entries) }, 'number');
    expect(p.newName).toBe('stake_number_2');
    const r = dryRunKindChange({ ...ctx, reserved: new Set(['stake_select']) }, 'select');
    expect(r.newName).toBe('stake_select_2');
    expect(newPropertyName('stake', 'number', ['odds', 'Stake_Number', 'stake_number_2'])).toBe(
      'stake_number_3',
    );
  });
});

describe('stripMisfitTests', () => {
  const view = (over: Partial<ViewDefinition>): ViewDefinition => ({
    id: 'v',
    name: 'V',
    icon: null,
    filters: null,
    presentation: { type: 'table', group: [], sort: [], columns: [] },
    ...over,
  });

  it('drops rules the new kind cannot express, collapsing emptied groups', () => {
    const v = view({
      filters: {
        all: [
          { field: 'priority', op: 'any_of', value: ['urgent', 'high'] },
          { any: [{ field: 'priority', op: 'none_of', value: ['low'] }] },
          { field: 'status', op: 'equals', value: 'progress' },
          { field: 'priority', op: 'is_not_empty' },
        ],
      },
    });
    const { views, stripped } = stripMisfitTests([v], 'priority', 'text');
    expect(stripped).toBe(2);
    expect(views[0].filters).toEqual({
      all: [
        { field: 'status', op: 'equals', value: 'progress' },
        { field: 'priority', op: 'is_not_empty' },
      ],
    });
  });

  it('nulls an emptied root and keeps an untouched view as it was', () => {
    const emptied = view({ filters: { any: [{ field: 'priority', op: 'any_of', value: [] }] } });
    const other = view({ id: 'o', filters: { all: [{ field: 'x', op: 'any_of', value: [] }] } });
    const { views } = stripMisfitTests([emptied, other], 'priority', 'number');
    expect(views[0].filters).toBeNull();
    expect(views[1]).toBe(other);
  });

  it('strips a dashboard’s global filter and every widget filter', () => {
    const v = view({
      presentation: {
        type: 'dashboard',
        group: [],
        sort: [],
        columns: [],
        dashboard: {
          global: { all: [{ field: 'priority', op: 'any_of', value: ['high'] }] },
          rows: [
            {
              id: 'r',
              widgets: [
                {
                  id: 'w1',
                  kind: 'table',
                  filter: { all: [{ field: 'priority', op: 'none_of', value: ['low'] }] },
                },
                {
                  id: 'w2',
                  kind: 'table',
                  filter: { all: [{ field: 'priority', op: 'contains', value: 'h' }] },
                },
              ],
            },
          ],
        },
      },
    });
    const { views, stripped } = stripMisfitTests([v], 'priority', 'text');
    expect(stripped).toBe(2);
    const dash = views[0].presentation.dashboard!;
    expect(dash.global).toBeUndefined();
    expect(dash.rows[0].widgets[0].filter).toBeUndefined();
    expect(dash.rows[0].widgets[1].filter).toEqual({
      all: [{ field: 'priority', op: 'contains', value: 'h' }],
    });
  });
});

describe('hints and the menu', () => {
  const preview = (over: Partial<KindChangePreview>): KindChangePreview => ({
    to: 'number',
    cast: 'checked',
    reason: null,
    holding: 4,
    converts: 4,
    failures: 0,
    examples: [],
    writes: [],
    options: null,
    stripped: 0,
    flaggedElsewhere: 0,
    newName: 'stake_number',
    lossless: true,
    ...over,
  });

  it('says what each row will do', () => {
    expect(kindChangeHint(preview({ cast: 'never', reason: 'Nope.' }))).toBe('Nope.');
    expect(kindChangeHint(preview({ lossless: false, failures: 3, converts: 1 }))).toBe(
      "3 won't convert · Converts into a new property",
    );
    expect(kindChangeHint(preview({}))).toBe('All 4 convert');
    expect(kindChangeHint(preview({ holding: 0, converts: 0 }))).toBe('');
  });

  it('previews every offered kind but the current one, once per entries', () => {
    const { ctx } = betVault(['12', 'abc']);
    const menu = kindChangeMenu(ctx);
    expect(menu.map((p) => p.to)).not.toContain('text');
    expect(menu.map((p) => p.to)).not.toContain('rollup');
    expect(menu.map((p) => p.to)).not.toContain('daterange');
    expect(menu).toHaveLength(12);
    expect(kindChangeMenu({ ...ctx })).toBe(menu);
  });
});
