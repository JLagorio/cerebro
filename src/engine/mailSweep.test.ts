import { expect, it } from 'vitest';
import { makeEntry } from './testHelpers';
import type { ConnectorStatusRow } from './connectors';
import { MAIL } from './mailPolicy';
import { newestMailFetch, pruneCandidates, sweepAgentDraft, sweepStatus } from './mailSweep';
const digest = (id: string, date: string | null = '2026-01-01T00:00:00Z') =>
  makeEntry({
    path: `sources/mail/${id}.md`,
    hash: `hash-${id}`,
    properties: {
      source_kind: 'thread',
      source_id: id,
      last_message_at: date,
      fetched_at: '2026-07-28T12:00:00Z',
    },
  });
const text = (id: string) =>
  makeEntry({
    path: `sources/mail/${id}-text.md`,
    hash: `text-${id}`,
    properties: { source_kind: 'thread_text', source_id: id },
  });
it('creates a paused attended reader with no record writes, schedule or broad connector grant', () => {
  const draft = sweepAgentDraft('Mail account', 'Mail_account');
  expect(draft).toMatchObject({
    folder: 'records/agents',
    slug: 'mail-sweep',
    frontmatter: {
      type: 'Agent',
      paused: true,
      tools: 'safe',
      scope: [],
      'read-scope': [MAIL.folder],
      connectors: ['Mail account'],
    },
  });
  expect(draft.frontmatter['allowed-tools']).toEqual([
    'search_notes',
    'get_note',
    'list_notes',
    'cache_source',
    ...MAIL.sweep.read_tools.map((name) => `mcp__Mail_account__${name}`),
  ]);
  expect(draft.frontmatter['disallowed-tools']).toEqual(
    MAIL.sweep.denied_tools.map((name) => `mcp__Mail_account__${name}`),
  );
  expect(draft.frontmatter).not.toHaveProperty('schedule');
  expect(draft.frontmatter).not.toHaveProperty('when');
  expect(() => sweepAgentDraft('bad.name')).toThrow('valid tool name');
  const tools = draft.body.match(/mcp__[A-Za-z0-9_-]+/g) ?? [];
  expect(tools).toEqual(['mcp__Mail_account__search_threads', 'mcp__Mail_account__get_thread']);
});
it('requests metadata, caps both searches together, excludes noisy categories and keeps sent mail', () => {
  const { body } = sweepAgentDraft('gmail');
  for (const words of [
    'newer_than:30d',
    'after:YYYY/MM/DD',
    'subtract one day',
    '-category:promotions',
    '-category:social',
    '-category:updates',
    '-category:forums',
    'in:sent',
    'THREAD_VIEW_MINIMAL',
    'pageSize: 50',
    '200 distinct threads',
    'messageFormat: METADATA_ONLY',
    'Never store snippets',
    'labels (labelIds)',
    'never draft, send, label, trash or mark spam',
  ])
    expect(body).toContain(words);
  expect(body).not.toContain('category:primary');
  expect(body).not.toContain('messageFormat: PLAIN_TEXT');
});
it('uses valid measured fetch times and never calls an unknown or failing connector up to date', () => {
  const a = digest('a');
  const b = digest('b');
  b.properties.fetched_at = '2026-07-28T14:00:00+03:00';
  const bad = digest('bad');
  bad.properties.fetched_at = 'not a date';
  expect(newestMailFetch([a, b, bad])).toBe('2026-07-28T12:00:00Z');
  expect(sweepStatus([], null)).toBe('Never swept · not checked yet');
  const base: ConnectorStatusRow = {
    connector: 'gmail',
    cli_name: 'gmail',
    refused: null,
    state: null,
    signal: null,
    seen_at: null,
    run_id: null,
  };
  for (const [state, words] of [
    ['needs_sign_in', 'needs sign-in'],
    ['not_approved', 'denied'],
    ['failed', 'unreachable'],
    ['working', 'connector working'],
  ] as const) {
    expect(sweepStatus([a], { ...base, state })).toBe(`As of 2026-07-28T12:00:00Z · ${words}`);
  }
  expect(sweepStatus([a], { ...base, state: 'working', refused: 'disabled' })).toContain('denied');
});
it('freezes old digest/text pairs with hashes, oldest first, leaving newer and unknown pages', () => {
  const undated = digest('undated', null),
    unreadable = digest('bad');
  unreadable.hash = null;
  const plan = pruneCandidates(
    [
      digest('b', '2026-02-01T00:00:00Z'),
      text('a'),
      digest('a'),
      undated,
      unreadable,
      digest('new', '2026-07-28T00:00:00Z'),
    ],
    '2026-04-01',
  );
  expect(plan.ops).toEqual([
    { op: 'delete', path: 'sources/mail/a.md', expectHash: 'hash-a' },
    { op: 'delete', path: 'sources/mail/a-text.md', expectHash: 'text-a' },
    { op: 'delete', path: 'sources/mail/b.md', expectHash: 'hash-b' },
  ]);
  expect(plan).toMatchObject({ digests: 2, textPages: 1, undated: 1, unreadable: 1, remaining: 0 });
});
it('never splits a pair at the cap or removes a mismatched text page', () => {
  expect(pruneCandidates([digest('a'), text('a')], '2026-04-01', 1)).toMatchObject({
    ops: [],
    remaining: 1,
  });
  const wrong = text('a');
  wrong.properties.source_id = 'another';
  expect(pruneCandidates([digest('a'), wrong], '2026-04-01')).toMatchObject({
    digests: 1,
    textPages: 0,
    keptText: 1,
  });
  expect(pruneCandidates([digest('a')], '2026-02-30').ops).toEqual([]);
});
it('counts unreadable mail even when malformed metadata hid its kind', () => {
  const broken = makeEntry({ path: 'sources/mail/broken.md', parseError: 'bad YAML' });
  expect(pruneCandidates([broken], '2026-04-01')).toMatchObject({ ops: [], unreadable: 1 });
});
