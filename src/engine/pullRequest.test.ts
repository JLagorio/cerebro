import { describe, expect, it } from 'vitest';
import urls from '../../src-tauri/fixtures/pr-urls.json';
import cases from '../../src-tauri/fixtures/pr-cases.json';
import { makeEntry } from './testHelpers';
import { buildSchema } from './schema';
import {
  checkState,
  findPullRequestUrls,
  originOf,
  parsePullRequestUrl,
  readinessOf,
  statusSuggestion,
  type PrRead,
  type PullRequest,
} from './pullRequest';

const reads = cases.cases.map((c) => c.expect as PrRead);
const passing = reads.find((r): r is Extract<PrRead, { state: 'read' }> => r.state === 'read')!;
const pr = (patch: Partial<PullRequest> = {}): PullRequest => ({ ...passing.pr, ...patch });
const read = (patch: Partial<PullRequest> = {}): PrRead => ({ ...passing, pr: pr(patch) });
const URL = 'https://github.com/acme/notes/pull/1';

describe('shared pull request fixtures', () => {
  it.each(urls.cases)('replays pr-urls: $name', ({ input, expect: expected }) => {
    expect(parsePullRequestUrl(input)).toEqual(expected);
  });
  it.each(cases.cases)('replays pr-cases readiness: $name', ({ expect: expected, readiness }) => {
    expect(readinessOf(expected as PrRead)).toBe(readiness);
  });
  it('every failed read says checks unknown', () => {
    for (const r of reads.filter((r) => r.state !== 'read'))
      expect(readinessOf(r)).toBe('checks_unknown');
  });
});

describe('readiness', () => {
  it('gives a known failure priority, then unknown, then running', () => {
    const failure = { kind: 'status_context', name: 'old', state: 'FAILURE' } as const;
    const running = { kind: 'check_run', name: 'new', status: 'QUEUED', conclusion: null } as const;
    expect(readinessOf(read({ checks: [running, { kind: 'unknown' }, failure] }))).toBe(
      'not_ready',
    );
    expect(readinessOf(read({ checks: [running, { kind: 'unknown' }] }))).toBe('checks_unknown');
    expect(readinessOf(read({ checks: [running] }))).toBe('not_ready');
    expect(
      checkState({ kind: 'check_run', name: null, status: 'COMPLETED', conclusion: 'NEW_WORD' }),
    ).toBe('unknown');
    expect(checkState({ kind: 'status_context', name: null, state: 'NEW_WORD' })).toBe('unknown');
  });
});

describe('body links', () => {
  it('finds markdown, autolinks and bare links once in first-seen order', () => {
    expect(
      findPullRequestUrls(
        `[PR](${URL}/files) <${URL}> ${URL}?a=b.\nhttps://github.com/acme/notes/pull/2!`,
      ).map((p) => p.number),
    ).toEqual([1]);
    expect(
      findPullRequestUrls(`${URL}. (${URL}) [second](https://github.com/acme/notes/pull/2)`).map(
        (p) => p.number,
      ),
    ).toEqual([1, 2]);
  });
  it.each([
    `\`${URL}\``,
    `\`\`a \` ${URL}\`\``,
    `\`multiline\n${URL}\``,
    `\`\`\`md\n${URL}\n\`\`\``,
    `~~~\n${URL}\n~~~`,
    `~~~\n${URL}`,
    `> \`\`\`\n> ${URL}\n> \`\`\``,
    `- ~~~\n  ${URL}\n  ~~~`,
    `    ${URL}`,
    `\t${URL}`,
    `<pre>${URL}</pre>`,
    `<code>${URL}</code>`,
    `<!-- ${URL} -->`,
  ])('does not read code: %s', (source) => expect(findPullRequestUrls(source)).toEqual([]));
  it('never joins fragments across omitted code into a new URL', () => {
    expect(findPullRequestUrls('https://git`code`hub.com/acme/notes/pull/1')).toEqual([]);
    expect(findPullRequestUrls('https://git<!-- hidden -->hub.com/acme/notes/pull/1')).toEqual([]);
  });
  it('keeps indented list code and alternating list/quote fences out', () => {
    expect(findPullRequestUrls('-     ' + URL)).toEqual([]);
    expect(findPullRequestUrls(' \t' + URL)).toEqual([]);
    expect(findPullRequestUrls('   \t' + URL)).toEqual([]);
    expect(findPullRequestUrls('- > ```\n  > ' + URL + '\n  > ```')).toEqual([]);
    expect(findPullRequestUrls('- ' + URL + '\n> - ' + URL)).toHaveLength(1);
  });
  it('leaves prose after closing fences and inline code intact', () => {
    expect(findPullRequestUrls(`~~~\n${URL}\n~~~\n${URL}\n\`x\` ${URL}`)).toHaveLength(1);
    expect(findPullRequestUrls(`unclosed \` marker ${URL}`)).toHaveLength(1);
  });
  it('does not close a fence with an indented marker inside its code', () => {
    for (const padding of ['    ', '\t', ' \t'])
      expect(findPullRequestUrls('```\n' + padding + '```\n' + URL + '\n```')).toEqual([]);
    expect(findPullRequestUrls('```\n   ```\n' + URL)).toHaveLength(1);
  });
  it('does not extract a valid suffix from a larger hostile URL', () => {
    for (const prefix of ['https://evil.test/', 'word'])
      expect(findPullRequestUrls(prefix + URL)).toEqual([]);
    expect(findPullRequestUrls('https://github.com.evil.test/acme/notes/pull/1')).toEqual([]);
  });
});

describe('origin hints', () => {
  it.each([
    ['Codex', 'https://chatgpt.com/codex/tasks/task_1'],
    ['Cursor', 'https://cursor.com/agents/bc-one'],
    ['Devin', 'https://app.devin.ai/sessions/one'],
    ['Jules', 'https://jules.google.com/session/one'],
  ])('recognizes an exact %s session link', (name, link) => {
    expect(
      originOf(pr({ body: `[Session](${link})`, headRefName: 'copilot/change' })),
    ).toMatchObject({ name, evidence: 'session link' });
    expect(originOf(pr({ body: link.replace('://', '://bad@') }))).toBeNull();
    expect(
      originOf(
        pr({ body: link.replace('.com/', '.com.evil.test/').replace('.ai/', '.ai.evil.test/') }),
      ),
    ).toBeNull();
    expect(originOf(pr({ body: `\`${link}\`` }))).toBeNull();
  });
  it('uses footer and trailer before a weak branch prefix', () => {
    expect(
      originOf(
        pr({ body: 'Summary\n\n🤖 Generated with Claude Code', headRefName: 'copilot/one' }),
      ),
    ).toMatchObject({ name: 'Claude Code', evidence: 'footer' });
    expect(originOf(pr({ body: 'Summary\n\nCo-Authored-By: Claude Code' }))).toMatchObject({
      name: 'Claude Code',
      evidence: 'trailer',
    });
    expect(originOf(pr({ headRefName: 'cursor/fix' }))).toMatchObject({
      name: 'Cursor',
      evidence: 'branch prefix',
    });
    expect(originOf(pr({ headRefName: 'copilot/fix' }))).toMatchObject({
      name: 'Copilot',
      evidence: 'branch prefix',
    });
  });
  it('never guesses human, arbitrary bots or a mention in prose', () => {
    expect(
      originOf(
        pr({
          author: 'someone[bot]',
          body: 'Generated with Claude Code examples follow\nSome text.',
        }),
      ),
    ).toBeNull();
    expect(originOf(pr())).toBeNull();
  });
});

describe('merged status suggestion', () => {
  const type = makeEntry({
    path: 'types/test.md',
    type: 'Type',
    title: 'Any name',
    properties: {
      fields: { progress: { kind: 'status' }, second: { kind: 'status' } },
      statuses: [
        { id: 'active', group: 'active' },
        { id: 'done', label: 'Landed', group: 'done' },
        { id: 'other', group: 'done' },
      ],
    },
  });
  const entry = makeEntry({
    path: 'tasks/one.md',
    type: 'Any name',
    properties: { progress: 'active' },
  });
  const schema = buildSchema([type, entry]);
  it('offers the first done status on the first status capability', () => {
    expect(statusSuggestion(entry, schema, [read({ state: 'MERGED' })])).toEqual({
      field: 'progress',
      value: 'done',
      label: 'Landed',
    });
  });
  it('requires every PR to be read and merged, and never offers on an already done row', () => {
    for (const values of [
      [],
      [null],
      [read({ state: 'MERGED' }), null],
      [read({ state: 'CLOSED' })],
      [{ state: 'gh_missing', checkedAt: '' } as PrRead],
    ])
      expect(statusSuggestion(entry, schema, values)).toBeNull();
    expect(
      statusSuggestion({ ...entry, properties: { progress: 'other' } }, schema, [
        read({ state: 'MERGED' }),
      ]),
    ).toBeNull();
    expect(
      statusSuggestion({ ...entry, type: null }, schema, [read({ state: 'MERGED' })]),
    ).toBeNull();
  });
});
