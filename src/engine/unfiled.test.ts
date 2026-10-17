import { describe, expect, it } from 'vitest';
import CASES from '../../src-tauri/fixtures/mail-dismissal-cases.json';
import { makeEntry } from './testHelpers';
import { buildSchema } from './schema';
import { correspondentTitle, dismissalValue, unfiledCorrespondents } from './unfiled';
export const personType = makeEntry({
  path: 'types/person.md',
  type: 'Type',
  title: 'Person',
  properties: {
    folder: 'people',
    fields: { email: 'email', company: { kind: 'relation', target: 'Company', limit: 1 } },
  },
});
export const companyType = makeEntry({
  path: 'types/company.md',
  type: 'Type',
  title: 'Company',
  properties: { folder: 'companies', email_domain: 'domain', fields: { domain: 'text' } },
});
export const thread = makeEntry({
  path: 'sources/mail/one.md',
  title: 'Hello',
  properties: {
    source_kind: 'thread',
    participants: [
      'me@our.example',
      'newperson@initech.example',
      'friend@gmail.com',
      'support@vendor.example',
      'dana@acme.example',
      'shared@globex.example',
      'incoming@other.example',
    ],
    sent_to: [
      'newperson@initech.example',
      'friend@gmail.com',
      'support@vendor.example',
      'dana@acme.example',
      'shared@globex.example',
    ],
    owner_addresses: ['me@our.example'],
    first_message_at: '2026-07-25T09:00:00Z',
    last_message_at: '2026-07-27T11:00:00Z',
    last_sent_at: '2026-07-27T09:00:00Z',
    last_from: 'me@our.example',
    needs_reply: false,
    message_count: 3,
  },
});
const read = (
  entries: ReturnType<typeof makeEntry>[],
  dismissed: Parameters<typeof unfiledCorrespondents>[2] = [],
) => unfiledCorrespondents(entries, buildSchema(entries), dismissed);
describe('shared dismissal cases', () => {
  it('replays src-tauri/fixtures/mail-dismissal-cases.json', () => {
    for (const row of CASES.cases)
      expect(dismissalValue(row.kind, row.value)).toEqual(
        'normalized' in row ? { ok: true, value: row.normalized } : { ok: false, error: row.error },
      );
    expect(dismissalValue('address', `${'a'.repeat(64)}@${'b'.repeat(256)}.example`).ok).toBe(
      false,
    );
  });
});
it('lists only sent-to, unclaimed, non-role addresses; consumer addresses never suggest companies', () => {
  const records = [
    makeEntry({
      path: 'people/dana.md',
      type: 'Person',
      properties: { email: 'dana@acme.example' },
    }),
    ...['a', 'b'].map((name) =>
      makeEntry({
        path: `people/${name}.md`,
        type: 'Person',
        properties: { email: 'shared@globex.example' },
      }),
    ),
  ];
  const view = read([personType, companyType, thread, ...records]);
  expect(view.rows.map((row) => [row.address, row.company.state])).toEqual([
    ['friend@gmail.com', 'consumer'],
    ['newperson@initech.example', 'unfiled'],
  ]);
  expect(view.rows[0]).toMatchObject({ name: null, lastSentAt: '2026-07-27T09:00:00Z' });
  expect(view.rows[0].threads).toHaveLength(1);
});
it('dismissal scopes address and domain independently, and company claims update from the scan', () => {
  const dismissed = [
    { kind: 'address' as const, value: 'friend@gmail.com', dismissedAt: '2026-10-15T00:00:00Z' },
    { kind: 'domain' as const, value: 'initech.example', dismissedAt: '2026-10-15T00:00:00Z' },
  ];
  expect(
    read([personType, companyType, thread], dismissed).rows.find(
      (row) => row.address === 'friend@gmail.com',
    ),
  ).toBeUndefined();
  expect(
    read([personType, companyType, thread], dismissed).rows.find(
      (row) => row.address === 'newperson@initech.example',
    )?.company.state,
  ).toBe('dismissed');
  const company = makeEntry({
    path: 'companies/initech.md',
    title: 'Initech',
    type: 'Company',
    properties: { domain: 'initech.example' },
  });
  expect(
    read([personType, companyType, thread, company], dismissed).rows.find(
      (row) => row.address === 'newperson@initech.example',
    )?.company,
  ).toEqual({ state: 'filed', entry: company });
});
it('distinguishes no cache, unreadable cache, and sent time absent; strips unsafe name markers', () => {
  expect(read([personType])).toEqual({ hasMail: false, unreadable: 0, rows: [] });
  expect(read([personType, { ...thread, parseError: 'bad' }])).toEqual({
    hasMail: true,
    unreadable: 1,
    rows: [],
  });
  const { last_sent_at: omitted, ...properties } = thread.properties;
  void omitted;
  expect(read([personType, { ...thread, properties }]).rows[0].lastSentAt).toBeNull();
  expect(correspondentTitle({ name: '[D]ana|#^', address: 'dana@acme.example' })).toBe('Dana');
  expect(correspondentTitle({ name: null, address: 'friend@gmail.com' })).toBe('friend');
});
