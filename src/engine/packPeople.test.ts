import { expect, it } from 'vitest';
import YAML from 'yaml';
import { PEOPLE_PACK } from './packPeople';
import { planPack } from './packs';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
it('both database docs parse, preserve their mail source and use a select stage', () => {
  const plan = planPack(PEOPLE_PACK, []);
  const entries = plan.ops.map((op) => {
    if (op.op !== 'create') throw new Error('create expected');
    return makeEntry({
      path: op.path,
      title: op.path.includes('company') ? 'Company' : 'Person',
      type: 'Type',
      properties: YAML.parse(op.content.split('---')[1]),
    });
  });
  const schema = buildSchema(entries);
  const company = schema.types.get('Company')!;
  const person = schema.types.get('Person')!;
  expect(company.emailDomain).toBe('domain');
  expect(company.folder).toBe('companies');
  expect(company.fields.find((f) => f.name === 'stage')).toMatchObject({
    kind: 'select',
    options: expect.arrayContaining([{ id: 'lead', label: 'Lead', color: null }]),
  });
  expect(company.views[0]).toMatchObject({
    id: 'pipeline',
    presentation: {
      type: 'board',
      group: [{ field: 'stage' }],
      sort: [{ field: 'last_interaction', dir: 'desc' }],
    },
  });
  expect(person.fields.find((f) => f.name === 'company')).toMatchObject({
    kind: 'relation',
    target: 'Company',
    limit: 1,
  });
  for (const type of [company, person])
    expect(type.fields.find((f) => f.name === 'last_interaction')).toMatchObject({
      source: 'correspondence',
      calculate: 'latest',
    });
  expect(planPack(PEOPLE_PACK, entries).ops).toEqual([]);
});
