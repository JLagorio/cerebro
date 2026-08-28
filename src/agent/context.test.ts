import { describe, expect, it } from 'vitest';
import { buildSnapshot, extractReferences } from '@/agent/context';
import { listConcepts } from '@/engine/okf';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';

const typeDoc = makeEntry({
  path: 'types/work-item.md',
  title: 'Work item',
  type: 'Type',
  properties: {
    fields: { status: { kind: 'text' }, owner: { kind: 'text' } },
  } as unknown as Record<string, never>,
});

const schema = buildSchema([typeDoc]);
const item = (path: string, status: string) =>
  makeEntry({ path, type: 'Work item', title: path, properties: { status } });

describe('extractReferences', () => {
  it('pulls wikilink targets out of a prompt', () => {
    expect(extractReferences('compare [[LNC-14]] and [[Atlas|the project]]')).toEqual([
      'LNC-14',
      'Atlas',
    ]);
  });

  it('dedupes and ignores plain text', () => {
    expect(extractReferences('[[a]] then [[a]] again')).toEqual(['a']);
    expect(extractReferences('nothing here')).toEqual([]);
  });
});

describe('buildSnapshot', () => {
  const entries = [typeDoc, item('a.md', 'progress'), item('b.md', 'review')];

  it('carries the rows the surface is showing', () => {
    const snap = buildSnapshot({
      selection: { kind: 'list', id: 'at-risk-work' },
      entries,
      schema,
      visible: entries.slice(1),
    });
    expect(snap.visibleRecords?.map((r) => r.path)).toEqual(['a.md', 'b.md']);
    expect(snap.visibleRecords?.[0].properties.status).toBe('progress');
  });

  // Silently truncating reads as the whole population, and the agent will
  // reason about it as one.
  it('says when the visible list was cut short', () => {
    const many = Array.from({ length: 60 }, (_, i) => item(`n${i}.md`, 'progress'));
    const snap = buildSnapshot({
      selection: { kind: 'home' },
      entries: [typeDoc, ...many],
      schema,
      visible: many,
    });
    expect(snap.visibleRecords).toHaveLength(40);
    expect(snap.visibleRecordsTruncated).toEqual({ shown: 40, total: 60 });
  });

  it('carries the active view filters so a subset is not read as the whole', () => {
    const filters = { all: [{ field: 'status', op: 'equals', value: 'progress' }] };
    const snap = buildSnapshot({
      selection: { kind: 'list', id: 'v' },
      entries,
      schema,
      visible: entries.slice(1),
      filters,
    });
    expect(snap.visibleFilters).toEqual(filters);
  });

  it('includes the active note and what it links to', () => {
    const linked = makeEntry({ path: 'linked.md', title: 'Linked', type: 'Work item' });
    const active = makeEntry({
      path: 'active.md',
      title: 'Active',
      type: 'Work item',
      outgoingLinks: ['Linked'],
    });
    const snap = buildSnapshot({
      selection: { kind: 'doc', path: 'active.md' },
      entries: [typeDoc, active, linked],
      schema,
      activePath: 'active.md',
      activeBody: '# Active\n\nSome body.',
    });
    expect(snap.activeNote?.path).toBe('active.md');
    expect(snap.activeNote?.body).toContain('Some body');
    expect(snap.linkedNotes?.map((l) => l.path)).toEqual(['linked.md']);
  });

  it('carries records attached as context chips, with their bodies (M17.6)', () => {
    const attachable = makeEntry({
      path: 'concepts/pricing.md',
      title: 'Pricing',
      snippet: 'Two tiers, annual only.',
    });
    const snap = buildSnapshot({
      selection: { kind: 'home' },
      entries: [...entries, attachable],
      schema,
      attached: ['concepts/pricing.md'],
    });
    expect(snap.attachedNotes?.map((n) => n.path)).toEqual(['concepts/pricing.md']);
    expect(snap.attachedNotes?.[0].body).toBe('Two tiers, annual only.');
  });

  it('does not repeat the active note among the attached ones', () => {
    // The open record is already in the snapshot in full, with its links.
    // Repeating it would spend context saying the same thing twice.
    const snap = buildSnapshot({
      selection: { kind: 'home' },
      entries,
      schema,
      activePath: 'a.md',
      attached: ['a.md', 'b.md'],
    });
    expect(snap.attachedNotes?.map((n) => n.path)).toEqual(['b.md']);
    expect(snap.activeNote?.path).toBe('a.md');
  });

  it('tells the agent where the conversation started when the user has moved', () => {
    // The alternative was asking the USER to do something about having walked
    // away. The model can hold "we started on the Roadmap" and "you are now in
    // the Inbox" at the same time; it only looked stupid when we showed it one
    // and hid the other.
    const snap = buildSnapshot({
      selection: { kind: 'inbox' },
      entries,
      schema,
      startedIn: 'Roadmap',
    });
    expect(snap.startedIn).toBe('Roadmap');
    expect(snap.selection).toEqual({ kind: 'inbox' });
  });

  it('stays quiet about it while the user is still where they started', () => {
    // The caller passes null rather than the current place, so the snapshot
    // never carries a line that says the same thing twice.
    const snap = buildSnapshot({ selection: { kind: 'inbox' }, entries, schema, startedIn: null });
    expect('startedIn' in snap).toBe(false);
  });

  // M44.5: the open record tab is part of "where the user is" — an agent told
  // only the path would describe the Overview while the user reads the Spec.
  it('a doc selection carries its open tab, and only when one is open', () => {
    const withTab = buildSnapshot({
      selection: { kind: 'doc', path: 'a.md', tab: 'spec' },
      entries,
      schema,
    });
    expect(withTab.selection).toEqual({ kind: 'doc', path: 'a.md', tab: 'spec' });
    const without = buildSnapshot({ selection: { kind: 'doc', path: 'a.md' }, entries, schema });
    expect(without.selection).toEqual({ kind: 'doc', path: 'a.md' });
  });

  it('says nothing about where the user is when the place chip was removed', () => {
    // "Do not tell it where I am standing" is a thing the user is allowed to
    // say. An empty object would say it badly — the key is simply absent.
    const snap = buildSnapshot({ entries, schema });
    expect('selection' in snap).toBe(false);
    expect(snap.vault.notes).toBe(3);
  });

  it('omits the agent’s own corpus from the vault note count', () => {
    const snap = buildSnapshot({
      selection: { kind: 'home' },
      entries: [...entries, makeEntry({ path: 'knowledge/x.md' })],
      schema,
    });
    // The knowledge bundle is the agent's output; counting it back would
    // report its own work to it as the user's.
    expect(snap.vault.notes).toBe(3);
  });
});

/**
 * M17.20 — the bundle reaches the turn.
 *
 * Every `about:` wikilink written since M8 paid off in the UI and never in the
 * agent's reasoning: the prompt said the bundle existed and the snapshot
 * carried zero concepts, so a conversation about a project could not see what
 * the base had already concluded about that project.
 */
describe('knowledge in the snapshot', () => {
  // Wikilink-valued fields arrive from the scanner bracket-stripped in
  // `relationships`, never in `properties` — the fixture has to use the shape
  // the Rust scanner actually produces or it tests a vault that cannot exist.
  const concept = (
    path: string,
    title: string,
    about: string,
    links: Record<string, string[]> = {},
    props: Record<string, unknown> = {},
  ) =>
    makeEntry({
      path: `knowledge/concepts/${path}`,
      title,
      properties: {
        type: 'concept',
        description: `${title} claim.`,
        ...props,
      } as unknown as Record<string, never>,
      relationships: { about: [about], ...links },
    });

  const project = makeEntry({ path: 'projects/atlas/project.md', title: 'Atlas' });

  const build = (entries: ReturnType<typeof makeEntry>[], input = {}) =>
    buildSnapshot({
      selection: { kind: 'home' },
      entries: [...entries, project],
      schema,
      activePath: 'projects/atlas/project.md',
      concepts: listConcepts([...entries, project], '2026-08-03'),
      ...input,
    });

  it('reaches concepts by about: anchor, not by looking similar', () => {
    const snap = build([concept('a.md', 'Pricing is annual', 'Atlas')]);
    expect(snap.knowledge?.map((k) => k.title)).toEqual(['Pricing is annual']);
    expect(snap.knowledge?.[0].about).toBe('projects/atlas/project.md');
  });

  it('carries nothing at all when the caller derived no bundle', () => {
    // Absent must not read as "the base is empty" — that is a claim, and a
    // wrong one whenever the caller simply did not pass concepts.
    const snap = buildSnapshot({
      selection: { kind: 'home' },
      entries: [project],
      schema,
      activePath: 'projects/atlas/project.md',
    });
    expect(snap.knowledge).toBeUndefined();
  });

  it('ignores a concept anchored somewhere else', () => {
    const other = makeEntry({ path: 'projects/beta/project.md', title: 'Beta' });
    const snap = build([concept('a.md', 'About Beta', 'Beta'), other]);
    expect(snap.knowledge).toBeUndefined();
  });

  it('leads with what could change the answer, not with what is settled', () => {
    // A contradiction is the most useful thing a base can say; a superseded
    // claim is the most dangerous thing to quote as current.
    const snap = build([
      concept(
        'settled.md',
        'Settled',
        'Atlas',
        {},
        {
          verified: [{ by: 'human:me', at: '2026-07-01' }],
        },
      ),
      concept('fresh.md', 'Unverified', 'Atlas'),
      concept('fight.md', 'Contested', 'Atlas', { contradicts: ['Settled'] }),
    ]);
    expect(snap.knowledge?.map((k) => k.title)).toEqual(['Contested', 'Unverified', 'Settled']);
  });

  it('says a claim was replaced rather than quoting it as current', () => {
    const snap = build([
      concept('old.md', 'Old belief', 'Atlas'),
      concept('new.md', 'New belief', 'Atlas', { supersedes: ['Old belief'] }),
    ]);
    const old = snap.knowledge?.find((k) => k.title === 'Old belief');
    expect(old?.supersededBy).toBe('knowledge/concepts/new.md');
    // …and it sorts first, so the agent reads the warning before the claim.
    expect(snap.knowledge?.[0].title).toBe('Old belief');
  });

  it('counts one belief once however many records in view it is about', () => {
    const beta = makeEntry({ path: 'projects/beta/project.md', title: 'Beta' });
    const shared = makeEntry({
      path: 'knowledge/concepts/shared.md',
      title: 'Shared',
      properties: { type: 'concept', description: 'One belief.' } as unknown as Record<
        string,
        never
      >,
      relationships: { about: ['Atlas', 'Beta'] },
    });
    const entries = [shared, beta, project];
    const snap = buildSnapshot({
      selection: { kind: 'home' },
      entries,
      schema,
      visible: [project, beta],
      concepts: listConcepts(entries, '2026-08-03'),
    });
    expect(snap.knowledge).toHaveLength(1);
  });

  it('is capped, so background belief cannot crowd out the question', () => {
    const many = Array.from({ length: 30 }, (_, i) => concept(`c${i}.md`, `Claim ${i}`, 'Atlas'));
    expect(build(many).knowledge?.length).toBe(8);
  });
});
