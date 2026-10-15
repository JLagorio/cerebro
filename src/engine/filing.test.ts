import { describe, expect, it } from 'vitest';
import { filingPlan, type OrganizeAsk } from './filing';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
import type { Entry } from './types';

/** An entry whose filename and folder follow its path, as the scanner gives them. */
function at(path: string, rest: Parameters<typeof makeEntry>[0] = {}): Entry {
  const slash = path.lastIndexOf('/');
  return makeEntry({
    path,
    filename: path.slice(slash + 1),
    folder: slash === -1 ? '' : path.slice(0, slash),
    ...rest,
  });
}

/**
 * Field kinds decide, never type names (CV-08): `Gathering` has one person
 * field, `Review` two, `Note` none; `Task` carries a targeted relation, a
 * single-link person field and a derived two-way side.
 */
function vault(extra: Entry[] = []): Entry[] {
  return [
    at('types/gathering.md', {
      title: 'Gathering',
      type: 'Type',
      properties: { fields: { date: { kind: 'date' }, attendees: { kind: 'person' } } },
    }),
    at('types/review.md', {
      title: 'Review',
      type: 'Type',
      properties: { fields: { reviewers: { kind: 'person' }, approvers: { kind: 'person' } } },
    }),
    at('types/note.md', { title: 'Note', type: 'Type', properties: { fields: {} } }),
    at('types/task.md', {
      title: 'Task',
      type: 'Type',
      properties: {
        fields: {
          owner: { kind: 'person', limit: 1 },
          project: { kind: 'relation', target: 'Project' },
          anything: { kind: 'relation' },
          blocks: { kind: 'relation', from: { type: 'Task', field: 'blocked_by' } },
        },
      },
    }),
    at('types/person.md', { title: 'Person', type: 'Type', properties: { fields: {} } }),
    at('types/project.md', { title: 'Project', type: 'Type', properties: { fields: {} } }),
    at('people/marcus-webb.md', { title: 'Marcus Webb', type: 'Person' }),
    at('people/priya-nair.md', { title: 'Priya Nair', type: 'Person' }),
    at('people/tom-keller.md', { title: 'Tom Keller', type: 'Person' }),
    at('records/projects/phoenix.md', { title: 'Phoenix', type: 'Project' }),
    at('knowledge/systems/drain.md', { title: 'Drain', type: 'Concept' }),
    ...extra,
  ];
}

const capture = (properties: Record<string, unknown> = {}, rest = {}) =>
  at('inbox/standup.md', { title: 'Standup', properties, ...rest });

function plan(ask: OrganizeAsk, entry = capture(), extra: Entry[] = []) {
  const entries = [...vault(extra), entry];
  return filingPlan(ask, entry, buildSchema(entries), entries);
}

describe('filingPlan: links', () => {
  it('writes plain names as [[stem]] and drops a name with no page', () => {
    const p = plan({ type: 'Gathering', properties: { attendees: ['Marcus Webb', 'Jo Nobody'] } });
    expect(p.patch).toEqual({ attendees: ['[[marcus-webb]]'], type: 'Gathering' });
    expect(p.links.map((l) => [l.field, l.pages.map((e) => e.title)])).toEqual([
      ['attendees', ['Marcus Webb']],
    ]);
    expect(p.unfiled).toEqual([{ field: 'attendees', target: 'Jo Nobody', why: 'no page' }]);
  });

  it("drops a person field's page that is not a person as not allowed here", () => {
    const p = plan({ type: 'Gathering', properties: { attendees: ['[[phoenix]]'] } });
    expect(p.patch).toEqual({ type: 'Gathering' });
    expect(p.unfiled).toEqual([{ field: 'attendees', target: 'phoenix', why: 'not allowed here' }]);
  });

  it("enforces a relation's target, and an untargeted one refuses Type docs and knowledge/", () => {
    const p = plan({
      type: 'Task',
      properties: {
        project: ['[[phoenix]]', '[[marcus-webb]]'],
        anything: ['[[marcus-webb]]', '[[drain]]', '[[person]]'],
      },
    });
    expect(p.patch).toEqual({
      project: ['[[phoenix]]'],
      anything: ['[[marcus-webb]]'],
      type: 'Task',
    });
    expect(p.unfiled).toEqual([
      { field: 'project', target: 'marcus-webb', why: 'not allowed here' },
      { field: 'anything', target: 'drain', why: 'not allowed here' },
      { field: 'anything', target: 'person', why: 'not allowed here' },
    ]);
  });

  it('keeps the first link of a limit: 1 field and lists the rest as over the limit', () => {
    const p = plan({ type: 'Task', properties: { owner: ['Marcus Webb', 'Priya Nair'] } });
    expect(p.patch).toEqual({ owner: ['[[marcus-webb]]'], type: 'Task' });
    expect(p.unfiled).toEqual([{ field: 'owner', target: 'Priya Nair', why: 'over the limit' }]);
  });

  it('never writes a derived two-way field', () => {
    const p = plan({ type: 'Task', properties: { blocks: ['[[phoenix]]'] } });
    expect(p.patch).toEqual({ type: 'Task' });
    expect(p.unfiled).toEqual([{ field: 'blocks', target: 'phoenix', why: 'not allowed here' }]);
  });

  it('keeps only the links that resolve on an undeclared key', () => {
    const p = plan({ type: 'Note', properties: { see: ['[[phoenix]]', '[[gone]]'] } });
    expect(p.patch).toEqual({ see: ['[[phoenix]]'], type: 'Note' });
    expect(p.unfiled).toEqual([{ field: 'see', target: 'gone', why: 'no page' }]);
  });

  it("checks against the capture's own type when none is proposed", () => {
    const typed = capture({}, { type: 'Gathering' });
    const p = plan({ properties: { attendees: ['Tom Keller', 'Jo Nobody'] } }, typed);
    expect(p.type).toBeNull();
    expect(p.patch).toEqual({ attendees: ['[[tom-keller]]'] });
  });
});

describe('filingPlan: what M53.18 wrote', () => {
  it('writes plain properties and the type as given, and the title on one line', () => {
    const p = plan({
      type: 'Note',
      title: '  Rehearse the\n rollback ',
      properties: { status: 'todo', priority: 'high', gone: null },
    });
    expect(p.patch).toEqual({ status: 'todo', priority: 'high', type: 'Note' });
    expect(p.title).toBe('Rehearse the rollback');
    expect(p.transcript).toBeNull();
    expect(p.unfiled).toEqual([]);
  });

  it('reads a title that is not a string as none', () => {
    expect(plan({ title: 42 }).title).toBe('');
  });

  it('a non-transcript keeps summary as an ordinary property', () => {
    expect(plan({ properties: { summary: '  as written  ' } }).patch).toEqual({
      summary: '  as written  ',
    });
  });
});

describe('filingPlan: transcripts', () => {
  const transcript = (speakers: unknown, more: Record<string, unknown> = {}) =>
    capture({ ingest_format: 'vtt', speakers, ...more });

  it('trims the summary, and a blank or absent one is null and writes no key', () => {
    const t = transcript([]);
    expect(plan({ properties: { summary: '  Two sentences.\n ' } }, t).transcript?.summary).toBe(
      'Two sentences.',
    );
    expect(plan({ properties: { summary: '  Two sentences. ' } }, t).patch).toEqual({
      summary: 'Two sentences.',
    });
    for (const summary of ['   ', undefined, 7]) {
      const p = plan({ type: 'Note', properties: { summary } }, t);
      expect(p.transcript?.summary).toBeNull();
      expect(p.patch).not.toHaveProperty('summary');
    }
  });

  it('joins matched speakers to the one person field the proposal fills, without duplicates', () => {
    const t = transcript(['Marcus Webb', 'Priya Nair', 'Jo Nobody']);
    const p = plan({ type: 'Gathering', properties: { attendees: ['Marcus Webb'] } }, t);
    expect(p.patch.attendees).toEqual(['[[marcus-webb]]', '[[priya-nair]]']);
    expect(p.transcript?.field).toBe('attendees');
    expect(p.transcript?.joined.map((e) => e.title)).toEqual(['Priya Nair']);
    expect(p.transcript?.why).toBeNull();
  });

  it('says why when the proposal fills no person field, or several', () => {
    const t = transcript(['Marcus Webb']);
    const none = plan({ type: 'Gathering', properties: { date: '2026-07-28' } }, t);
    expect(none.transcript).toMatchObject({ field: null, joined: [], why: 'no person field' });
    expect(none.patch).not.toHaveProperty('attendees');
    const several = plan(
      { type: 'Review', properties: { reviewers: ['Tom Keller'], approvers: ['Priya Nair'] } },
      t,
    );
    expect(several.transcript).toMatchObject({ why: 'several person fields' });
    expect(several.patch.reviewers).toEqual(['[[tom-keller]]']);
  });

  it('says nothing about speakers when none matched', () => {
    const p = plan({ type: 'Gathering', properties: { attendees: [] } }, transcript(null));
    expect(p.transcript).toEqual({ summary: null, field: null, joined: [], why: null });
  });
});
