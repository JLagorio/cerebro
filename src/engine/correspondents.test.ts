import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import DIGESTS from '../../src-tauri/fixtures/thread-digests.json';
import { makeEntry } from './testHelpers';
import { buildSchema } from './schema';
import { formatTimestamp } from './properties';
import { serializeFields } from './typeCatalog';
import type { Entry } from './types';
import {
  normalizeDomain,
  classifyAddress,
  correspondenceView,
  getCorrespondenceIndex,
  recordAddresses,
  threadDigests,
} from './correspondents';

const contact = makeEntry({
  path: 'types/contact.md',
  title: 'Contact',
  type: 'Type',
  properties: {
    fields: { email: { kind: 'email' }, work: { kind: 'email' }, other: { kind: 'text' } },
  },
});
const dana = makeEntry({
  path: 'contacts/dana.md',
  title: 'Dana',
  type: 'Contact',
  properties: { email: 'Dana@Example.Test', work: 'dana@acme.example' },
});
const owner = makeEntry({
  path: 'contacts/me.md',
  title: 'Me',
  type: 'Contact',
  properties: { email: 'owner@example.test' },
});
function digest(name: string): Entry {
  const content = DIGESTS.find((c) => c.name === name)!.content!;
  return makeEntry({
    path: `sources/mail/${name}.md`,
    title: name,
    properties: YAML.parse(content.split('---')[1]),
  });
}
const index = (entries: Entry[]) => getCorrespondenceIndex(entries, buildSchema(entries));
describe('correspondence through declared email fields', () => {
  it('uses real digest headers, deduplicates records and finds the last sender', () => {
    const entries = [contact, dana, owner, digest('waiting-on-you'), digest('two-people-replied')];
    const read = index(entries);
    expect(read.owners).toEqual(new Set(['owner@example.test']));
    const view = correspondenceView(dana, read);
    expect(view).toMatchObject({
      state: 'record',
      waiting: 1,
      lastSentAt: '2026-07-27T11:00:00Z',
      unreadable: 0,
    });
    if (view.state !== 'record') throw new Error('record view expected');
    expect(view.threads.map((t) => t.entry.path)).toEqual([
      'sources/mail/two-people-replied.md',
      'sources/mail/waiting-on-you.md',
    ]);
    expect(correspondenceView(owner, read)).toEqual({ state: 'you', unreadable: 0 });
    expect(read.resolved.has('owner@example.test')).toBe(false);
    expect(getCorrespondenceIndex(entries, buildSchema(entries))).toBe(read);
  });
  it('never claims undeclared, knowledge or mail properties', () => {
    const extra = makeEntry({ path: 'notes/extra.md', properties: { email: 'dana@example.test' } });
    const wrong = {
      ...dana,
      path: 'contacts/wrong.md',
      properties: { other: 'dana@example.test' },
    };
    const knowledge = { ...dana, path: 'knowledge/dana.md' };
    const mail = { ...dana, path: 'sources/mail/dana.md' };
    const entries = [contact, dana, extra, wrong, knowledge, mail, digest('waiting-on-you')];
    const read = index(entries);
    expect(read.resolved.get('dana@example.test')?.path).toBe(dana.path);
    for (const entry of [extra, wrong, knowledge, mail])
      expect(recordAddresses(entry, buildSchema(entries))).toEqual([]);
    expect(recordAddresses(dana, buildSchema(entries))).toEqual([
      'dana@example.test',
      'dana@acme.example',
    ]);
  });
  it('keeps shared addresses unresolved and names both pages', () => {
    const duplicate = { ...dana, path: 'contacts/other-dana.md', title: 'Another Dana' };
    const read = index([contact, dana, duplicate, digest('waiting-on-you')]);
    expect(read.resolved.size).toBe(0);
    expect(read.byRecord.size).toBe(0);
    expect(correspondenceView(dana, read)).toMatchObject({
      state: 'record',
      threads: [],
      ambiguous: [
        { address: 'dana@example.test', others: [duplicate] },
        { address: 'dana@acme.example', others: [duplicate] },
      ],
    });
  });
  it('counts unreadable caches and never substitutes the scan timestamp', () => {
    const unreadable = digest('waiting-on-you');
    const entries = [
      contact,
      dana,
      { ...unreadable, properties: { ...unreadable.properties, last_message_at: 'yesterday' } },
    ];
    expect(threadDigests(entries)).toEqual({ hasMail: true, unreadable: 1, threads: [] });
    expect(correspondenceView(dana, index(entries))).toMatchObject({
      state: 'record',
      lastMessageAt: null,
      lastSentAt: null,
      unreadable: 1,
    });
    expect(
      threadDigests([{ ...unreadable, parseError: 'bad YAML', properties: {} }]),
    ).toMatchObject({ hasMail: true, unreadable: 1 });
  });
  it('is silent without a cache or a declared email, and updates on a new snapshot', () => {
    const entries = [contact, dana];
    expect(correspondenceView(dana, index(entries))).toEqual({ state: 'silent' });
    const next = [...entries, digest('waiting-on-you')];
    expect(index(next)).not.toBe(index(entries));
    expect(correspondenceView(contact, index(next))).toEqual({ state: 'silent' });
  });
  it('classifies owners before roles, then consumer and business domains', () => {
    const read = { owners: new Set(['info@acme.example']) };
    expect(classifyAddress('INFO@acme.example', read)).toBe('owner');
    expect(classifyAddress('support@gmail.com', read)).toBe('role');
    expect(classifyAddress('dana@gmail.com', read)).toBe('consumer');
    expect(classifyAddress('dana@acme.example', read)).toBe('business');
  });
  it('orders offset timestamps by instant, not lexical spelling', () => {
    const a = digest('waiting-on-you');
    const b = {
      ...a,
      path: 'sources/mail/later.md',
      properties: { ...a.properties, last_message_at: '2026-07-27T06:00:00-05:00' },
    };
    expect(threadDigests([a, b]).threads.map((t) => t.entry.path)).toEqual([b.path, a.path]);
  });
});

describe('company domains and cached-mail rollups', () => {
  const companyType = makeEntry({
    path: 'types/company.md',
    type: 'Type',
    title: 'Company',
    properties: {
      email_domain: ' domain ',
      fields: {
        domain: 'url',
        latest: {
          kind: 'rollup',
          source: 'correspondence',
          property: 'last_message_at',
          calculate: 'latest',
        },
        earliest: {
          kind: 'rollup',
          source: 'correspondence',
          property: 'first_message_at',
          calculate: 'earliest',
        },
        count: { kind: 'rollup', source: 'correspondence', calculate: 'count' },
        sent: {
          kind: 'rollup',
          source: 'correspondence',
          property: 'last_sent_at',
          calculate: 'latest',
        },
      },
    },
  });
  const company = makeEntry({
    path: 'companies/acme.md',
    type: 'Company',
    title: 'Acme',
    properties: { domain: 'https://ACME.example/about' },
  });
  function companyDigest(): Entry {
    const d = digest('waiting-on-you');
    return {
      ...d,
      properties: {
        ...d.properties,
        participants: ['owner@example.test', 'dana@acme.example', 'lee@acme.example'],
        owner_addresses: ['owner@example.test'],
        last_from: 'dana@acme.example',
      },
    };
  }
  it('attributes one thread once, sorts actual instants and renders dates as dates', () => {
    const d = companyDigest();
    const entries = [companyType, company, d];
    const schema = buildSchema(entries);
    expect(schema.types.get('Company')?.emailDomain).toBe('domain');
    const read = getCorrespondenceIndex(entries, schema);
    expect(read.resolvedDomains.get('acme.example')).toBe(company);
    expect(correspondenceView(company, read)).toMatchObject({
      state: 'record',
      domain: 'acme.example',
      threads: [expect.anything()],
      waiting: 1,
    });
    expect(schema.fieldValue(company, 'latest')).toBe(d.properties.last_message_at);
    expect(schema.fieldValue(company, 'earliest')).toBe(d.properties.first_message_at);
    expect(schema.fieldValue(company, 'count')).toBe(1);
    expect(schema.resolveField(company, 'latest').display).toBe(
      formatTimestamp(String(d.properties.last_message_at)),
    );
    expect(serializeFields(schema.types.get('Company')!.fields).latest).toMatchObject({
      source: 'correspondence',
    });
  });
  it('keeps every rollup blank before mail exists, and absent sent dates blank afterwards', () => {
    const empty = buildSchema([companyType, company]);
    for (const name of ['latest', 'earliest', 'count', 'sent']) {
      expect(empty.fieldValue(company, name)).toBeUndefined();
      expect(empty.resolveField(company, name).display).toBe('');
    }
    const d = companyDigest();
    const { last_sent_at: omitted, ...properties } = d.properties;
    void omitted;
    expect(
      buildSchema([companyType, company, { ...d, properties }]).fieldValue(company, 'sent'),
    ).toBeUndefined();
    const unknown = { ...d, parseError: 'unreadable' };
    expect(
      buildSchema([companyType, company, unknown]).fieldValue(company, 'count'),
    ).toBeUndefined();
    expect(
      buildSchema([
        companyType,
        { ...company, properties: { domain: 'other.example' } },
        d,
      ]).fieldValue({ ...company, properties: { domain: 'other.example' } }, 'count'),
    ).toBe(0);
  });
  it('refuses consumer and own domains, leaves duplicate domains unresolved, and ignores role participants', () => {
    const d = companyDigest();
    for (const [domain, reason] of [
      ['gmail.com', 'consumer'],
      ['example.test', 'owner'],
    ] as const) {
      const record = { ...company, properties: { domain } };
      const read = index([companyType, record, d]);
      expect(read.resolvedDomains.size).toBe(0);
      expect(correspondenceView(record, read)).toMatchObject({ state: 'domain-blocked', reason });
    }
    const copy = { ...company, path: 'companies/copy.md' };
    const shared = index([companyType, company, copy, d]);
    expect(shared.byRecord.size).toBe(0);
    expect(shared.ambiguousDomains.get('acme.example')).toEqual([company, copy]);
    const roles = {
      ...d,
      properties: {
        ...d.properties,
        participants: ['owner@example.test', 'support@acme.example'],
        last_from: 'support@acme.example',
      },
    };
    expect(index([companyType, company, roles]).byRecord.size).toBe(0);
  });
  it('normalizes web domains without accepting identities hidden in credentials or IP addresses', () => {
    expect(normalizeDomain(' https://ACME.example/about ')).toBe('acme.example');
    expect(normalizeDomain('Acme.example.')).toBe('acme.example');
    for (const value of [
      'acme',
      'https://me@acme.example',
      'mailto:dana@acme.example',
      '127.0.0.1',
      'a..example',
      'a b.example',
    ])
      expect(normalizeDomain(value)).toBeNull();
  });
});
