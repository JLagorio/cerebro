import { describe, expect, it } from 'vitest';
import CASES from '../../src-tauri/fixtures/set-fields-cases.json';
import { buildSchema } from './schema';
import {
  parseSetFieldsRequest,
  planSetFields,
  setFieldsRefusal,
  setFieldsReport,
  type SetFieldsPlan,
} from './setFields';
import type { Entry } from './types';

interface CorpusEntry {
  path: string;
  title: string;
  type: string | null;
  properties: Record<string, unknown>;
}

interface Case {
  name: string;
  record: string;
  project: string | null;
  frontmatter: Record<string, unknown>;
  unreadable: string[];
  args: Record<string, unknown>;
  patch?: Record<string, unknown>;
  notes?: string[];
  refused?: string[];
  error?: string;
}

function entryOf(raw: CorpusEntry): Entry {
  const cut = raw.path.lastIndexOf('/');
  return {
    path: raw.path,
    filename: raw.path.slice(cut + 1),
    folder: cut === -1 ? '' : raw.path.slice(0, cut),
    project: null,
    title: raw.title,
    type: raw.type,
    properties: raw.properties as Entry['properties'],
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-28T00:00:00Z',
    modifiedAt: '2026-07-28T00:00:00Z',
    parseError: null,
    hash: null,
  };
}

const ENTRIES = (CASES.corpus as CorpusEntry[]).map(entryOf);
const SCHEMA = buildSchema(ENTRIES);

function outcome(c: Case): SetFieldsPlan | { error: string } {
  const parsed = parseSetFieldsRequest(c.args);
  if ('error' in parsed) return parsed;
  return planSetFields(
    {
      entries: ENTRIES,
      schema: SCHEMA,
      recordPath: c.record,
      project: c.project,
      mayRead: (path) => !c.unreadable.includes(path),
    },
    c.frontmatter,
    parsed.ok,
  );
}

function expected(c: Case): Record<string, unknown> {
  const want: Record<string, unknown> = {};
  for (const key of ['patch', 'notes', 'refused', 'error'] as const) {
    if (c[key] !== undefined) want[key] = c[key];
  }
  return want;
}

const cases = CASES.cases as Case[];
const named = (fragment: string): Case => {
  const found = cases.find((c) => c.name.includes(fragment));
  if (found === undefined) throw new Error(`no case named like ${fragment}`);
  return found;
};

describe('set-fields-cases.json (M60.4)', () => {
  it('holds every rule', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(outcome(c)).toEqual(expected(c));
  });

  it('words the report and the refusal as Rust does', () => {
    for (const r of CASES.texts.reports) {
      expect(setFieldsReport(r.path, r.notes, r.hash, r.changed)).toBe(r.text);
    }
    for (const r of CASES.texts.refusals) {
      expect(setFieldsRefusal(r.path, r.problems)).toBe(r.text);
    }
  });
});

describe('planSetFields', () => {
  it('stores a label as its option id, the project override first', () => {
    expect(outcome(named('A status label is stored as its id'))).toMatchObject({
      patch: { status: 'in-progress' },
    });
    expect(outcome(named("The project's statuses override wins"))).toMatchObject({
      patch: { status: 'shipping' },
    });
  });

  it('runs its three option passes in order, never one combined pass', () => {
    // findOptionByLabel's single pass would take the first option whose
    // label matches ("soon", labelled Later); the slug pass answers first.
    expect(outcome(named('where the passes disagree'))).toMatchObject({
      patch: { phase: 'later' },
    });
  });

  it('refuses a link to another database, naming the one it expects', () => {
    expect(outcome(named('A link to a record of another type is refused'))).toEqual({
      refused: ['epic takes Epic records; [[write-copy]] is typed Task'],
    });
  });

  it('names options only when their source is readable', () => {
    const open = outcome(named('a default status is a ghost, kept and named'));
    const closed = outcome(named('Under a project override the run cannot read'));
    expect('notes' in open && open.notes[0]).toContain('(options: planned');
    expect('notes' in closed && closed.notes[0]).not.toContain('options:');
  });
});
