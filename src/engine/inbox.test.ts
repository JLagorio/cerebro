import { describe, expect, it } from 'vitest';
import { inInbox, inboxCount, inboxEntries, isOrganized, isStructural } from './inbox';
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

describe('inboxEntries', () => {
  const entries = [
    makeEntry({ path: 'inbox/a.md', title: 'A', createdAt: daysAgo(1) }),
    makeEntry({ path: 'inbox/b.md', title: 'B', createdAt: daysAgo(10) }),
    makeEntry({ path: 'inbox/c.md', title: 'C', createdAt: daysAgo(60) }),
    makeEntry({ path: 'records/r.md', title: 'R', type: 'Risk', createdAt: daysAgo(1) }),
    makeEntry({ path: 'types/risk.md', title: 'Risk', type: 'Type', createdAt: daysAgo(1) }),
  ];

  it('returns every unorganized note newest first, however old', () => {
    // No period narrows the queue: a capture two months old still waits.
    expect(inboxEntries(entries).map((e) => e.title)).toEqual(['A', 'B', 'C']);
  });

  it('keeps a capture whose creation time cannot be read', () => {
    const untimed = [
      ...entries,
      makeEntry({ path: 'inbox/u.md', title: 'U', createdAt: '' }),
      makeEntry({ path: 'inbox/n.md', title: 'N', createdAt: 'not-a-date' }),
    ];
    expect(
      inboxEntries(untimed)
        .map((e) => e.title)
        .sort(),
    ).toEqual(['A', 'B', 'C', 'N', 'U']);
  });

  it('counts the whole queue for the nav badge, agreeing with the list', () => {
    expect(inboxCount(entries)).toBe(3);
    expect(inboxCount(entries)).toBe(inboxEntries(entries).length);
  });
});
