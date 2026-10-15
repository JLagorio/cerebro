import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import {
  isLinkablePage,
  linkTargetOf,
  linkTargetsFor,
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
import { resolveLink, resolveTarget } from './wikilink';

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

  it('links a page by its filename stem', () => {
    expect(linkTargetOf(PLAN, VAULT)).toBe('plan');
    expect(linkTargetOf(TICKET, VAULT)).toBe('t-1');
  });
});

describe('a link that reaches the page it was written for', () => {
  // The demo vault's shape: four meetings/kickoff.md files share one stem,
  // and `resolveTarget`'s stem pass gives `[[kickoff]]` to the first.
  const KICKOFFS = [
    makeEntry({ path: 'projects/field-app/meetings/kickoff.md', title: 'Field App kickoff' }),
    makeEntry({ path: 'projects/sync/meetings/kickoff.md', title: 'Offline sync kickoff' }),
  ];
  const ATLAS = makeEntry({ path: 'projects/atlas/project.md', title: 'Atlas' });
  const ORBIT = makeEntry({ path: 'projects/orbit/project.md', title: 'Orbit' });
  // Shares the stem with the first kickoff AND the title with the second.
  const IMPOSTOR = makeEntry({ path: 'notes/kickoff.md', title: 'Offline sync kickoff' });
  const ALL = [...KICKOFFS, ATLAS, ORBIT, PLAN];

  it('writes the stem when it is the page’s own, and the title when another page has it', () => {
    expect(linkTargetOf(KICKOFFS[0], ALL)).toBe('kickoff');
    expect(linkTargetOf(KICKOFFS[1], ALL)).toBe('Offline sync kickoff');
  });

  it('writes a project by its folder, since every project is a project.md', () => {
    expect(linkTargetOf(ATLAS, ALL)).toBe('atlas');
    expect(linkTargetOf(ORBIT, ALL)).toBe('orbit');
    // A stem named like the folder takes it, so the project falls back.
    const atlasNote = makeEntry({ path: 'notes/atlas.md', title: 'Atlas notes' });
    expect(linkTargetOf(ATLAS, [atlasNote, ...ALL])).toBe('project');
  });

  it('gives null when every name the page has reaches another page', () => {
    expect(linkTargetOf(IMPOSTOR, [...KICKOFFS, IMPOSTOR])).toBeNull();
  });

  it('refuses a name the scanners would read differently', () => {
    const piped = makeEntry({ path: 'a/x.md', title: 'A | B' });
    expect(linkTargetOf(piped, [makeEntry({ path: 'b/x.md' }), piped])).toBeNull();
  });

  it('points a section link at the page too', () => {
    const targetOf = linkTargetsFor(ALL);
    expect(targetOf(KICKOFFS[0], 'Agenda')).toBe('kickoff#Agenda');
    expect(targetOf(KICKOFFS[1], 'Agenda')).toBe('Offline sync kickoff#Agenda');
    // A title with a `#` reaches its page whole, but cut at its `#` it would not.
    const sharp = makeEntry({ path: 'b/plan.md', title: 'C# notes' });
    const vault = [PLAN, sharp];
    expect(linkTargetsFor(vault)(sharp)).toBe('C# notes');
    expect(linkTargetsFor(vault)(sharp, 'Risks')).toBeNull();
  });

  it('every name it writes resolves back to its page', () => {
    const vault = [...ALL, IMPOSTOR, makeEntry({ path: 'a/plan.md', title: 'kickoff' })];
    const targetOf = linkTargetsFor(vault);
    for (const entry of vault) {
      const target = targetOf(entry);
      if (target !== null) expect(resolveTarget(target, vault)).toBe(entry);
      const section = targetOf(entry, 'Risks');
      if (section !== null)
        expect(resolveLink(section, vault)).toEqual({ entry, section: 'Risks' });
    }
  });
});
