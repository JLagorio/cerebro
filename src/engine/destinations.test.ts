import { describe, expect, it } from 'vitest';
import tools from '../../shared/policy/tools.v1.json';
import {
  DESTINATIONS,
  GO_KEYS,
  destination,
  isDestinationKind,
  NAVIGATE_PLACES,
  NAVIGATE_VIEW,
  navigateTarget,
  visibleDestinations,
  type NavigateTarget,
} from './destinations';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { Selection } from './types';

/** Every Selection kind, classified: a mapped type, so a kind added to
 * Selection fails here until this test says which side it is on. */
const SIDE: { [K in Selection['kind']]: 'destination' | 'subject' } = {
  home: 'destination',
  pages: 'destination',
  inbox: 'destination',
  mywork: 'destination',
  knowledge: 'destination',
  changes: 'destination',
  pulse: 'destination',
  library: 'destination',
  workspace: 'destination',
  studio: 'destination',
  agents: 'destination',
  settings: 'destination',
  doc: 'subject',
  diagram: 'subject',
  file: 'subject',
  collection: 'subject',
  list: 'subject',
  type: 'subject',
};

describe('the destination table (M59.1)', () => {
  it('is this table, in this order', () => {
    expect(DESTINATIONS.map((d) => [d.id, d.kind, d.label, d.icon, d.nav])).toEqual([
      ['inbox', 'inbox', 'Inbox', 'inbox', 'row'],
      ['home', 'home', 'Home', 'house', 'row'],
      ['pages', 'pages', 'Pages', 'files', 'section'],
      ['my_work', 'mywork', 'My work', 'circle-check', 'row'],
      ['studio', 'studio', 'Studio', 'pencil-ruler', 'row'],
      ['history', 'pulse', 'History', 'activity', 'row'],
      ['library', 'library', 'Library', 'blocks', 'row'],
      ['work', 'workspace', 'Work', 'folder-tree', 'section'],
      ['knowledge', 'knowledge', 'Knowledge', 'brain', 'section'],
      ['agents', 'agents', 'Agents', 'bot', 'section'],
      ['changes', 'changes', 'Changes', 'file-diff', 'none'],
      ['settings', 'settings', 'Settings', 'settings', 'footer'],
    ]);
  });

  it('spells every id as its label, lower-cased, spaces as _', () => {
    for (const d of DESTINATIONS) {
      expect(d.id).toBe(d.label.toLowerCase().replace(/ /g, '_'));
    }
  });

  it('holds every destination kind exactly once, and no subject kind', () => {
    const kinds = DESTINATIONS.map((d) => d.kind);
    const want = (Object.keys(SIDE) as Selection['kind'][]).filter(
      (k) => SIDE[k] === 'destination',
    );
    expect([...kinds].sort()).toEqual([...want].sort());
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const k of Object.keys(SIDE) as Selection['kind'][]) {
      expect(isDestinationKind(k), k).toBe(SIDE[k] === 'destination');
    }
  });

  it('goes to the bare selection of its own kind', () => {
    for (const d of DESTINATIONS) expect(d.selection).toEqual({ kind: d.kind });
  });

  it('lights History on both git surfaces, and each other row on its own kind', () => {
    expect(destination('pulse').lights).toEqual(['pulse', 'changes']);
    for (const d of DESTINATIONS) {
      if (d.kind === 'pulse') continue;
      expect(d.lights, d.kind).toEqual(d.nav === 'row' || d.nav === 'footer' ? [d.kind] : []);
    }
  });

  it('says History for pulse and Work for workspace', () => {
    expect(destination('pulse').label).toBe('History');
    expect(destination('workspace').label).toBe('Work');
  });
});

describe('visibleDestinations', () => {
  it('hides only Inbox when the inbox workflow is off', () => {
    const on = visibleDestinations({ inboxEnabled: true }).map((d) => d.kind);
    const off = visibleDestinations({ inboxEnabled: false }).map((d) => d.kind);
    expect(on).toEqual(DESTINATIONS.map((d) => d.kind));
    expect(off).toEqual(on.filter((k) => k !== 'inbox'));
  });

  it('names the nav rows, the footer and the three section doors', () => {
    const at = (nav: string) => DESTINATIONS.filter((d) => d.nav === nav);
    expect(at('row').map((d) => d.label)).toEqual([
      'Inbox',
      'Home',
      'My work',
      'Studio',
      'History',
      'Library',
    ]);
    expect(at('footer').map((d) => d.label)).toEqual(['Settings']);
    expect(at('section').map((d) => [d.label, d.door])).toEqual([
      ['Pages', 'Browse all pages'],
      ['Work', 'Open all repositories'],
      ['Knowledge', 'Open Knowledge'],
      ['Agents', 'Open all agents'],
    ]);
  });
});

describe("navigate's served schema matches the table", () => {
  const row = tools.tools.find((t) => t.name === 'navigate');
  const schema = row?.input_schema as
    { properties: Record<string, { enum?: string[] }>; required: string[] } | undefined;

  it('serves `to` as the table ids then view, in order', () => {
    expect(schema?.properties.to.enum).toEqual([...NAVIGATE_PLACES]);
    expect(NAVIGATE_PLACES).toEqual([...DESTINATIONS.map((d) => d.id), NAVIGATE_VIEW]);
  });

  it('takes exactly to, database and view, and requires only to', () => {
    expect(Object.keys(schema?.properties ?? {})).toEqual(['to', 'database', 'view']);
    expect(schema?.required).toEqual(['to']);
  });
});

describe('navigateTarget', () => {
  const entries = [
    makeEntry({
      path: 'types/work-item.md',
      title: 'Work item',
      type: 'Type',
      properties: {
        views: [
          { id: 'board', name: 'Board', presentation: { type: 'board' } },
          { id: 'table', name: 'Table', presentation: { type: 'table' } },
        ],
      },
    }),
    makeEntry({ path: 'work/a.md', title: 'A', type: 'Work item' }),
  ];
  const schema = buildSchema(entries);
  const go = (to: string, database?: string, view?: string): NavigateTarget =>
    navigateTarget({ to, database, view }, entries, schema);

  it('sends every destination id to its row', () => {
    for (const d of DESTINATIONS) expect(go(d.id)).toEqual({ selection: d.selection });
  });

  it('opens a database on a view named by id or by name, ignoring case', () => {
    for (const view of ['board', 'Board', 'BOARD']) {
      expect(go('view', 'Work item', view)).toEqual({
        selection: { kind: 'type', name: 'Work item', view: 'board' },
      });
    }
  });

  it('matches the database ignoring case, and opens its canonical name', () => {
    expect(go('view', 'work item')).toEqual({ selection: { kind: 'type', name: 'Work item' } });
  });

  it('opens the first tab for a view the database does not have', () => {
    const target = go('view', 'Work item', 'calendar');
    expect(target).toEqual({ selection: { kind: 'type', name: 'Work item' } });
    expect('selection' in target && 'view' in target.selection).toBe(false);
  });

  it('refuses an unknown database, a blank one, and a word the table does not hold', () => {
    expect(go('view', 'Roadmap')).toEqual({ refused: 'No database is named "Roadmap".' });
    for (const [to, database] of [
      ['view', undefined],
      ['view', '  '],
      ['list', undefined],
      ['pulse', undefined],
      ['workspace', undefined],
      ['', undefined],
    ] as const) {
      const target = go(to, database);
      expect('refused' in target, `${to}/${String(database)}`).toBe(true);
    }
  });

  it('never sends a refusal Home', () => {
    for (const to of ['list', 'pulse', '', 'docs', 'mywork']) {
      expect(go(to)).not.toEqual({ selection: { kind: 'home' } });
    }
  });

  it('refuses two databases whose names differ only in case', () => {
    const twins = [
      ...entries,
      makeEntry({ path: 'types/risk.md', title: 'Risk', type: 'Type' }),
      makeEntry({ path: 'types/risk-2.md', title: 'RISK', type: 'Type' }),
    ];
    const target = navigateTarget({ to: 'view', database: 'risk' }, twins, buildSchema(twins));
    expect('refused' in target).toBe(true);
  });
});

it('every destination has one unique go key, never the list leader', () => {
  const letters = DESTINATIONS.map((place) => place.go);
  expect(new Set(letters).size).toBe(DESTINATIONS.length);
  expect(letters.every((letter) => letter.length === 1 && letter !== 'g')).toBe(true);
  expect(GO_KEYS).toEqual({
    inbox: 'g i',
    home: 'g h',
    pages: 'g p',
    my_work: 'g m',
    studio: 'g s',
    history: 'g y',
    library: 'g l',
    work: 'g w',
    knowledge: 'g k',
    agents: 'g a',
    changes: 'g c',
    settings: 'g ,',
  });
});

it('exactly Inbox and Work are single places (M65.8)', () => {
  expect(DESTINATIONS.filter((row) => row.single).map((row) => row.id)).toEqual(['inbox', 'work']);
});
