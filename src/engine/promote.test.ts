import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import { makeDateValue } from './dates';
import { buildSchema } from './schema';
import { planLine, promotionMapping, promotionTargets, type ChecklistLine } from './promote';

export const line = (patch: Partial<ChecklistLine> = {}): ChecklistLine => ({
  blockId: 'line',
  checked: false,
  title: 'Ship docs',
  due: null,
  extraDates: [],
  people: [],
  flattened: false,
  onlyLink: false,
  text: 'Ship docs',
  snapshot: '',
  ...patch,
});
function fixture() {
  const type = makeEntry({
    path: 'types/ticket.md',
    title: 'Ticket',
    type: 'Type',
    properties: {
      deadline: 'due',
      statuses: [
        { id: 'todo', group: 'active' },
        { id: 'done', group: 'done' },
      ],
      fields: {
        stage: { kind: 'status' },
        due: { kind: 'date' },
        window: { kind: 'daterange' },
        assignee: { kind: 'person' },
        owner: { kind: 'person', limit: 1 },
        epic: { kind: 'relation', target: 'Epic' },
        parent: { kind: 'relation', target: 'Ticket', limit: 1 },
        peers: { kind: 'relation', target: 'Ticket' },
        inverse: { kind: 'relation', from: { type: 'Ticket', field: 'parent' } },
      },
    } as never,
  });
  const epicType = makeEntry({
    path: 'types/epic.md',
    title: 'Epic',
    type: 'Type',
    properties: { fields: { state: { kind: 'status' } } } as never,
  });
  const epic = makeEntry({
    path: 'records/epics/release.md',
    title: 'Release programme',
    type: 'Epic',
  });
  const task = makeEntry({
    path: 'records/tickets/parent.md',
    title: 'Parent task',
    type: 'Ticket',
  });
  const person = makeEntry({ path: 'people/maya.md', title: 'Maya Chen', type: 'Person' });
  const entries = [type, epicType, epic, task, person];
  const schema = buildSchema(entries);
  const mapping = promotionMapping('Ticket', epic, schema)!;
  return { entries, schema, mapping, epic, task };
}

describe('checklist promotion plans', () => {
  it('offers status capabilities in name order and excludes reserved names', () => {
    const { schema } = fixture();
    schema.types.set('Agent', { ...schema.types.get('Ticket')!, name: 'Agent' });
    expect(promotionTargets(schema).map((type) => type.name)).toEqual(['Epic', 'Ticket']);
  });

  it('maps the declared deadline and people, and offers parents only from task-like sources', () => {
    const { schema, epic, task } = fixture();
    expect(promotionMapping('Ticket', epic, schema)).toMatchObject({
      deadline: { name: 'due' },
      people: [{ name: 'assignee' }, { name: 'owner' }],
      parents: [{ name: 'epic' }],
      parentDefault: 'epic',
    });
    expect(promotionMapping('Ticket', task, schema)?.parents.map((field) => field.name)).toEqual([
      'parent',
    ]);
    expect(promotionMapping('Ticket', makeEntry({ path: 'doc.md' }), schema)?.parents).toEqual([]);
    schema.types.get('Ticket')!.deadline = null;
    expect(promotionMapping('Ticket', epic, schema)?.deadline).toBeNull();
    expect(promotionMapping('missing', epic, schema)).toBeNull();
  });

  it('maps unchecked/checked status, due and people, and uses the parent stem', () => {
    const { entries, schema, mapping, epic } = fixture();
    const plan = planLine(
      line({ due: makeDateValue('2026-10-20'), people: ['Maya Chen'] }),
      'Ticket',
      epic,
      mapping,
      { person: 'assignee', parent: 'epic' },
      entries,
      schema,
    );
    expect(plan).toMatchObject({
      kind: 'create',
      values: { stage: 'todo', due: '2026-10-20', assignee: ['[[maya]]'], epic: '[[release]]' },
      body: '# Ship docs\n',
      notes: [],
    });
    expect(
      planLine(
        line({ checked: true }),
        'Ticket',
        null,
        mapping,
        { person: null, parent: null },
        entries,
        schema,
      ),
    ).toMatchObject({ values: { stage: 'done' } });
  });

  it('keeps unmapped chips and extra dates as page text', () => {
    const { entries, schema, mapping } = fixture();
    const source = line({
      due: makeDateValue('2026-10-20'),
      people: ['maya'],
      extraDates: [makeDateValue('2026-10-21')],
      text: 'Ship docs 📅 2026-10-20 @[[maya]] 📅 2026-10-21',
    });
    expect(
      planLine(
        source,
        'Ticket',
        null,
        { ...mapping, deadline: null, people: [] },
        { person: null, parent: null },
        entries,
        schema,
      ),
    ).toMatchObject({
      body: `# Ship docs\n\n${source.text}\n`,
      notes: [
        'The date stays in the page: Ticket has no deadline field.',
        'The people stay in the page: Ticket has no person field.',
      ],
    });
  });

  it('keeps the first person on limit 1, naming the loss and preserving all people in the body', () => {
    const { entries, schema, mapping } = fixture();
    const source = line({
      people: ['Maya Chen', 'maya', 'other'],
      text: 'Ship docs @[[Maya Chen]] @[[maya]] @[[other]]',
    });
    expect(
      planLine(source, 'Ticket', null, mapping, { person: 'owner', parent: null }, entries, schema),
    ).toMatchObject({
      values: { owner: ['[[maya]]'] },
      notes: ['Kept the first person: owner holds one.'],
      body: `# Ship docs\n\n${source.text}\n`,
    });
  });

  it('serializes a declared range, while a single-day deadline preserves a dropped end in the body', () => {
    const { entries, schema, mapping } = fixture();
    const source = line({
      due: { ...makeDateValue('2026-10-20'), end: '2026-10-21', startTime: '09:00' },
      text: 'Ship docs 📅 2026-10-20 09:00 → 2026-10-21',
    });
    expect(
      planLine(
        source,
        'Ticket',
        null,
        { ...mapping, deadline: { name: 'window', kind: 'daterange' } },
        { person: null, parent: null },
        entries,
        schema,
      ),
    ).toMatchObject({ values: { window: { start: '2026-10-20 09:00', end: '2026-10-21' } } });
    expect(
      planLine(source, 'Ticket', null, mapping, { person: null, parent: null }, entries, schema),
    ).toMatchObject({ body: `# Ship docs\n\n${source.text}\n` });
  });

  it('skips empty lines and existing links without creating a record', () => {
    const { entries, schema, mapping } = fixture();
    expect(
      planLine(
        line({ title: '' }),
        'Ticket',
        null,
        mapping,
        { person: null, parent: null },
        entries,
        schema,
      ),
    ).toEqual({ kind: 'skip', reason: 'empty' });
    expect(
      planLine(
        line({ onlyLink: true }),
        'Ticket',
        null,
        mapping,
        { person: null, parent: null },
        entries,
        schema,
      ),
    ).toEqual({ kind: 'skip', reason: 'link' });
  });
});
