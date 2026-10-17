import { expect, it } from 'vitest';
import { makeEntry } from './testHelpers';
import { PEOPLE_PACK } from './packPeople';
import { packPlanWords, planPack } from './packs';
it('adds missing fields only and compares the read hash', () => {
  const person = makeEntry({
    path: 'custom/person.md',
    type: 'Type',
    title: 'Person',
    hash: 'a'.repeat(64),
    properties: {
      fields: { email: 'text', extra: 'checkbox' },
      views: [{ id: 'mine' }],
      folder: 'contacts',
    },
  });
  const plan = planPack(PEOPLE_PACK, [person]);
  expect(plan.creates).toEqual(['types/company.md']);
  expect(plan.ops[1]).toEqual({
    op: 'patch',
    path: person.path,
    expectHash: person.hash,
    set: {
      fields: {
        email: 'text',
        extra: 'checkbox',
        company: { kind: 'relation', target: 'Company', limit: 1 },
        role: { kind: 'text' },
        phone: { kind: 'phone' },
        last_interaction: {
          kind: 'rollup',
          source: 'correspondence',
          property: 'last_message_at',
          calculate: 'latest',
        },
      },
    },
  });
  expect(packPlanWords(plan)).toEqual([
    'Creates types/company.md.',
    'Adds company, role, phone and last interaction to Person.',
  ]);
});
it('refuses collisions, unreadable schema and duplicate names as a whole', () => {
  for (const entries of [
    [makeEntry({ path: 'types/company.md', type: null })],
    [makeEntry({ path: 'types/company.md', type: 'Type', title: 'Company', parseError: 'bad' })],
    ['a', 'b'].map((name) =>
      makeEntry({ path: `types/${name}.md`, type: 'Type', title: 'Company' }),
    ),
  ]) {
    const plan = planPack(PEOPLE_PACK, entries);
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.ops).toEqual([]);
  }
});
