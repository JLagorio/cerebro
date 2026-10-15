// @vitest-environment jsdom
import { parseViewList, serializeViewList } from './views';
import { makeEntry } from './testHelpers';
import { beforeAll, describe, expect, it } from 'vitest';
import fixture from '../../src-tauri/fixtures/view-suggestion-cases.json';
import { scanVault } from '@/lib/mockIpc';
import { buildSchema } from './schema';
import {
  answerText,
  checkSuggestion,
  closestName,
  parseSuggestionResult,
  completeSuggestion,
  sameView,
  suggestedViewName,
} from './viewSuggestion';
import type { Entry, Schema } from './types';

let entries: Entry[], schema: Schema;
beforeAll(async () => {
  const fs = (window as unknown as { __cerebroMockFs: Map<string, string> }).__cerebroMockFs;
  fs.clear();
  for (const row of fixture.corpus) fs.set(row.path, row.content);
  entries = await scanVault('suggestions');
  schema = buildSchema(entries);
});
describe('replays the shared view suggestion cases', () => {
  for (const row of fixture.cases)
    it(row.name, () => {
      const result = checkSuggestion(row.args, schema, entries);
      expect(
        result.ok ? { answer: answerText(result.suggestion) } : { [result.kind]: result.text },
      ).toEqual(row.expect);
    });
});
it('closest names prefer case, normalized spelling, then bounded transpositions', () => {
  const names = ['Due date', 'owner', 'Priority'];
  expect(closestName('priority', names)).toBe('Priority');
  expect(closestName('due_date', names)).toBe('Due date');
  expect(closestName('owenr', names)).toBe('owner');
  expect(closestName('z'.repeat(20000), ['a'.repeat(20000)])).toBeNull();
});
it('only a checked success envelope parses as a suggestion', () => {
  const result = checkSuggestion(fixture.cases[0].args, schema, entries);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(parseSuggestionResult(answerText(result.suggestion))).toEqual(result.suggestion);
  for (const input of [
    null,
    '',
    '{}',
    'schema_invalid: no',
    JSON.stringify({ suggested: result.suggestion }),
  ])
    expect(parseSuggestionResult(input)).toBeNull();
});

it('completes sparse views through the saved-view reader and preserves them through serialization', () => {
  const checked = checkSuggestion(fixture.cases[0].args, schema, entries);
  if (!checked.ok) throw new Error(checked.text);
  const complete = completeSuggestion(checked.suggestion);
  expect(complete.presentation.columns).toEqual([]);
  expect(parseViewList(serializeViewList([complete]))).toEqual([complete]);
  expect(sameView(complete, { ...complete, id: 'other', name: 'Other', icon: 'star' })).toBe(true);
  expect(
    sameView(complete, { ...complete, presentation: { ...complete.presentation, limit: 1 } }),
  ).toBe(false);
  expect(suggestedViewName('Overdue', ['overDUE', 'OVERDUE 2', 'Overdue 4'])).toBe('Overdue 3');
  expect(suggestedViewName('New', [])).toBe('New');
});

it('rejects deeply malformed historical payloads before preview reads them', () => {
  const checked = checkSuggestion(fixture.cases[0].args, schema, entries);
  if (!checked.ok) throw new Error(checked.text);
  const bad = (patch: Record<string, unknown>) =>
    JSON.stringify({
      suggested: {
        ...checked.suggestion,
        view: { name: 'Bad', presentation: { type: 'table', ...patch } },
      },
      note: 'The user sees this view as a card with a live preview. Nothing is written unless they add it.',
    });
  for (const patch of [
    { group: {} },
    { sort: [null] },
    { columns: [{ field: 3 }] },
    { limit: 0 },
    { type: 'chart', chart: { kind: 'bar' } },
    { type: 'gallery', gallery: { cover: [] } },
    { rowHeight: 'tall' },
  ])
    expect(parseSuggestionResult(bad(patch))).toBeNull();
});

it('never offers reserved Agent memory fields, even if declared and held', () => {
  const doc = makeEntry({
    path: 'types/agent.md',
    title: 'Agent',
    type: 'Type',
    properties: {
      fields: {
        role: { kind: 'text' },
        recent: { kind: 'text' },
        memory: { kind: 'text' },
        preferences: { kind: 'text' },
      },
    },
  });
  const record = makeEntry({
    path: 'agents/one.md',
    type: 'Agent',
    properties: { role: 'reader', recent: 'private', memory: 'private', preferences: 'private' },
  });
  const corpus = [doc, record];
  const result = checkSuggestion(
    {
      database: 'Agent',
      view: {
        name: 'Memory',
        presentation: {
          type: 'table',
          columns: [{ field: 'memory' }, { field: 'recent' }, { field: 'preferences' }],
        },
      },
    },
    buildSchema(corpus),
    corpus,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.problems).toHaveLength(3);
  for (const problem of result.problems ?? []) expect(problem.message).toMatch(/has no field/);
  expect(result.text).not.toContain('private');
});

it('orders held names by Unicode code point, including astral characters', () => {
  const doc = makeEntry({ path: 'types/t.md', title: 'T', type: 'Type' });
  const record = makeEntry({
    path: 'one.md',
    type: 'T',
    properties: { '\u{10000}': 'a', '\uE000': 'b' },
  });
  const corpus = [doc, record];
  const result = checkSuggestion(
    {
      database: 'T',
      view: { name: 'Names', presentation: { type: 'table', columns: [{ field: 'zzzzzzzzzz' }] } },
    },
    buildSchema(corpus),
    corpus,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.text).toContain(
    'Its fields: title, type, createdAt, modifiedAt, \uE000, \u{10000}.',
  );
});

it('parses every successful canonical answer and refuses every refusal', () => {
  for (const row of fixture.cases) {
    const result = checkSuggestion(row.args, schema, entries);
    const output = result.ok ? answerText(result.suggestion) : result.text;
    expect(parseSuggestionResult(output), row.name).toEqual(result.ok ? result.suggestion : null);
  }
});
