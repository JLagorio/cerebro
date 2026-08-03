import { describe, expect, it } from 'vitest';
import {
  humanizeStem,
  hasRealTitle,
  inInbox,
  inboxCount,
  inboxCounts,
  inboxEntries,
  isOrganized,
  isStructural,
  organizeChecklist,
  withinPeriod,
} from './inbox';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('isOrganized', () => {
  it('treats a typed note as organized and an untyped one as a capture', () => {
    expect(isOrganized(makeEntry({ type: 'Work item' }))).toBe(true);
    expect(isOrganized(makeEntry({ type: null }))).toBe(false);
  });

  it('lets an explicit _organized flag override the type default', () => {
    // A typed note pulled BACK into the Inbox for rework.
    expect(isOrganized(makeEntry({ type: 'Work item', properties: { _organized: false } }))).toBe(
      false,
    );
    // An untyped note deliberately kept out of the queue.
    expect(isOrganized(makeEntry({ type: null, properties: { _organized: true } }))).toBe(true);
  });

  it('ignores a non-boolean _organized rather than trusting it', () => {
    expect(isOrganized(makeEntry({ type: null, properties: { _organized: 'yes' } }))).toBe(false);
    expect(isOrganized(makeEntry({ type: 'Risk', properties: { _organized: 'no' } }))).toBe(true);
  });
});

describe('isStructural', () => {
  it('excludes schema, project, template, and OKF reserved files', () => {
    expect(isStructural(makeEntry({ type: 'Type', path: 'types/risk.md' }))).toBe(true);
    expect(isStructural(makeEntry({ filename: 'project.md' }))).toBe(true);
    expect(isStructural(makeEntry({ filename: 'index.md' }))).toBe(true);
    expect(isStructural(makeEntry({ filename: 'log.md' }))).toBe(true);
    expect(isStructural(makeEntry({ folder: 'templates', path: 'templates/meeting.md' }))).toBe(
      true,
    );
    expect(isStructural(makeEntry({ filename: 'capture.md', folder: 'inbox' }))).toBe(false);
  });

  it('keeps structural files out of the Inbox even with no type', () => {
    // project.md carries no `type`, so without the structural guard every
    // project in the vault would queue for organizing.
    expect(inInbox(makeEntry({ filename: 'project.md', type: null }))).toBe(false);
  });
});

describe('withinPeriod', () => {
  it('bounds week and month, and lets all through', () => {
    const old = makeEntry({ createdAt: daysAgo(45) });
    expect(withinPeriod(old, 'week', NOW)).toBe(false);
    expect(withinPeriod(old, 'month', NOW)).toBe(false);
    expect(withinPeriod(old, 'all', NOW)).toBe(true);

    const recent = makeEntry({ createdAt: daysAgo(3) });
    expect(withinPeriod(recent, 'week', NOW)).toBe(true);
  });

  it('surfaces an unparseable createdAt instead of hiding it', () => {
    expect(withinPeriod(makeEntry({ createdAt: 'not-a-date' }), 'week', NOW)).toBe(true);
  });
});

describe('inboxEntries', () => {
  const entries = [
    makeEntry({ path: 'inbox/a.md', title: 'A', createdAt: daysAgo(1) }),
    makeEntry({ path: 'inbox/b.md', title: 'B', createdAt: daysAgo(10) }),
    makeEntry({ path: 'inbox/c.md', title: 'C', createdAt: daysAgo(60) }),
    makeEntry({ path: 'records/r.md', title: 'R', type: 'Risk', createdAt: daysAgo(1) }),
    makeEntry({ path: 'types/risk.md', title: 'Risk', type: 'Type', createdAt: daysAgo(1) }),
  ];

  it('returns unorganized notes newest first', () => {
    expect(inboxEntries(entries, 'all', NOW).map((e) => e.title)).toEqual(['A', 'B', 'C']);
  });

  it('narrows by period', () => {
    expect(inboxEntries(entries, 'week', NOW).map((e) => e.title)).toEqual(['A']);
    expect(inboxEntries(entries, 'month', NOW).map((e) => e.title)).toEqual(['A', 'B']);
  });

  it('counts each period and the whole queue', () => {
    expect(inboxCounts(entries, NOW)).toEqual({ week: 1, month: 2, all: 3 });
    expect(inboxCount(entries)).toBe(3);
  });
});

describe('hasRealTitle', () => {
  it('recognises the humanized-filename fallback as untitled', () => {
    expect(humanizeStem('capture-2026-07-28.md')).toBe('Capture 2026 07 28');
    expect(hasRealTitle(makeEntry({ filename: 'fld-7.md', title: 'Fld 7' }))).toBe(false);
    expect(hasRealTitle(makeEntry({ filename: 'fld-7.md', title: 'Warehouse cutover' }))).toBe(
      true,
    );
  });

  it('accepts a title the filename was generated FROM', () => {
    // Every capture and every ingested doc is named by slugifying its own
    // title, so the stem round-trips exactly — this used to read as untitled
    // forever, and no amount of retyping the H1 could satisfy the check.
    expect(
      hasRealTitle(
        makeEntry({
          filename: 'standup-notes-for-tuesday.md',
          title: 'Standup notes for tuesday',
        }),
      ),
    ).toBe(true);
  });

  it('still flags a machine-minted stem', () => {
    expect(
      hasRealTitle(
        makeEntry({
          filename: 'capture-2026-07-28-1432.md',
          title: 'Capture 2026 07 28 1432',
        }),
      ),
    ).toBe(false);
    expect(hasRealTitle(makeEntry({ filename: 'x.md', title: 'X' }))).toBe(false);
    expect(hasRealTitle(makeEntry({ filename: 'notes.md', title: '' }))).toBe(false);
  });
});

describe('organizeChecklist', () => {
  const typeDoc = makeEntry({
    path: 'types/work-item.md',
    filename: 'work-item.md',
    folder: 'types',
    title: 'Work item',
    type: 'Type',
    properties: {
      statuses: [
        { id: 'todo', label: 'To do', group: 'active' },
        { id: 'done', label: 'Done', group: 'done' },
      ],
    },
  });

  it('flags what an untyped capture is still missing', () => {
    const capture = makeEntry({ path: 'inbox/x.md', filename: 'x.md', title: 'X' });
    const checks = organizeChecklist(capture, buildSchema([capture]));
    expect(checks.map((c) => c.id)).toEqual(['title', 'type', 'links']);
    expect(checks.every((c) => !c.done)).toBe(true);
  });

  it('asks for a status only once the type declares one', () => {
    const untyped = makeEntry({ path: 'inbox/x.md' });
    expect(
      organizeChecklist(untyped, buildSchema([untyped, typeDoc])).some((c) => c.id === 'status'),
    ).toBe(false);

    const item = makeEntry({ path: 'items/1.md', type: 'Work item' });
    const checks = organizeChecklist(item, buildSchema([item, typeDoc]));
    expect(checks.find((c) => c.id === 'status')?.done).toBe(false);
  });

  it('passes every check for a fully organized note', () => {
    const item = makeEntry({
      path: 'items/1.md',
      filename: 'fld-7.md',
      title: 'Warehouse cutover',
      type: 'Work item',
      properties: { status: 'todo' },
      relationships: { belongs_to: ['phoenix'] },
    });
    const checks = organizeChecklist(item, buildSchema([item, typeDoc]));
    expect(checks.every((c) => c.done)).toBe(true);
  });

  it('counts a body wikilink as a connection', () => {
    const item = makeEntry({ path: 'inbox/x.md', outgoingLinks: ['kickoff'] });
    const links = organizeChecklist(item, buildSchema([item])).find((c) => c.id === 'links');
    expect(links?.done).toBe(true);
  });
});
