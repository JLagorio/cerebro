import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import {
  isLinkablePage,
  PAGE_CARD_FENCE,
  pageLinkOf,
  parsePageRef,
  resolvePageRef,
  serializePageRef,
  statusFieldOf,
  UNSET,
} from './pageCard';
import { buildSchema } from './schema';
import type { Entry } from './types';

const PLAN = makeEntry({ path: 'delivery/plan.md', title: 'The plan' });
const TICKET = makeEntry({
  path: 'records/tickets/t-1.md',
  title: 'Fix the login',
  type: 'Ticket',
  properties: { state: 'open' },
});
const TICKET_TYPE = makeEntry({
  path: 'types/ticket.md',
  title: 'Ticket',
  type: 'Type',
  properties: {
    statuses: [{ id: 'open', group: 'active', color: '#DE8F0A' }],
    fields: { owner: { kind: 'person' }, state: { kind: 'status' } },
  } as unknown as Entry['properties'],
});
const VAULT = [PLAN, TICKET, TICKET_TYPE];

describe('the cerebro-page fence body', () => {
  it('is the fence the card is written in', () => {
    expect(PAGE_CARD_FENCE).toBe('cerebro-page');
  });

  it.each(['[[a]]', '[[a|b]]', '[[a#h]]', '[[a#h|The heading]]', '[[ a ]]'])(
    'round-trips %s byte for byte',
    (body) => {
      const ref = parsePageRef(body);
      expect(ref).not.toBeNull();
      expect(serializePageRef(ref!)).toBe(body);
    },
  );

  it('reads the empty body as the unset card, and writes it back empty', () => {
    expect(parsePageRef('')).toEqual(UNSET);
    expect(parsePageRef('  \n')).toEqual(UNSET);
    expect(serializePageRef(UNSET)).toBe('');
  });

  it('splits the target from the alias', () => {
    expect(parsePageRef('[[a|b]]')).toEqual({ target: 'a', alias: 'b' });
    expect(parsePageRef('[[a]]')).toEqual({ target: 'a', alias: '' });
  });

  it('keeps a fragment in the pointer', () => {
    expect(parsePageRef('[[plan#Risks]]')).toEqual({ target: 'plan#Risks', alias: '' });
  });

  it.each(['[[a]] x', '[[a]][[b]]', '[[a]]\n[[b]]', 'a', '[[]]', '[[  ]]', '[[a|]]', '[a]'])(
    'gives null for %j, which stays a code block',
    (body) => {
      expect(parsePageRef(body)).toBeNull();
    },
  );

  it('reads a lone pasted link, trimmed, and nothing else', () => {
    expect(pageLinkOf('  [[plan]]\n')).toEqual({ target: 'plan', alias: '' });
    expect(pageLinkOf('see [[plan]]')).toBeNull();
    expect(pageLinkOf('')).toBeNull();
  });
});

describe('resolvePageRef', () => {
  it('resolves a stem, and a title', () => {
    expect(resolvePageRef({ target: 'plan', alias: '' }, VAULT)).toBe(PLAN);
    expect(resolvePageRef({ target: 'The plan', alias: 'x' }, VAULT)).toBe(PLAN);
  });

  it('cuts the fragment before resolving, and leaves the pointer whole', () => {
    const ref = { target: 'plan#Risks', alias: '' };
    expect(resolvePageRef(ref, VAULT)).toBe(PLAN);
    expect(ref.target).toBe('plan#Risks');
  });

  it('resolves a dangling or unset card to nothing', () => {
    expect(resolvePageRef({ target: 'no-such-page', alias: '' }, VAULT)).toBeNull();
    expect(resolvePageRef(UNSET, VAULT)).toBeNull();
  });
});

describe('statusFieldOf', () => {
  const schema = buildSchema(VAULT);

  it('finds a status-kind field by its kind, whatever it is named', () => {
    expect(statusFieldOf(TICKET, schema)).toMatchObject({ name: 'state', kind: 'status' });
  });

  it('gives null for an untyped doc', () => {
    expect(statusFieldOf(PLAN, schema)).toBeNull();
  });

  it('gives null for a type with no status field', () => {
    const note = makeEntry({ path: 'n/x.md', type: 'Unknown' });
    expect(statusFieldOf(note, schema)).toBeNull();
  });
});

describe('linkability', () => {
  it('leaves out Type docs, templates and .mmd files', () => {
    expect(isLinkablePage(PLAN)).toBe(true);
    expect(isLinkablePage(TICKET)).toBe(true);
    expect(isLinkablePage(TICKET_TYPE)).toBe(false);
    expect(isLinkablePage(makeEntry({ path: 'templates/meeting.md' }))).toBe(false);
    expect(isLinkablePage(makeEntry({ path: 'diagrams/flow.mmd', title: 'flow' }))).toBe(false);
  });
});
