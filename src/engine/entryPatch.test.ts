import { describe, expect, it } from 'vitest';
import { makeEntry } from '@/test/factories';
import { applyEntryPatch, garbledKey } from './entryPatch';

describe('entry patches', () => {
  it('moves values between properties and relationships without mutating the source', () => {
    const before = makeEntry({
      path: 'a.md',
      properties: { owner: 'Alex', due: 'tomorrow' },
      relationships: { related: ['old'] },
      hash: 'a'.repeat(64),
    });
    const after = applyEntryPatch(
      before,
      { owner: '[[alex]]', related: 'plain', due: null },
      '2026-10-15T00:00:00Z',
    );
    expect(after.properties).toEqual({ related: 'plain' });
    expect(after.relationships).toEqual({ owner: ['alex'] });
    expect(after.modifiedAt).toBe('2026-10-15T00:00:00Z');
    expect(after.hash).toBeNull();
    expect(before.properties).toEqual({ owner: 'Alex', due: 'tomorrow' });
    expect(before.relationships).toEqual({ related: ['old'] });
  });

  it('drafts keep their supplied time and retain false, zero and empty lists', () => {
    const before = makeEntry({ path: 'a.md' });
    const after = applyEntryPatch(before, { done: false, count: 0, labels: [], absent: undefined });
    expect(after.properties).toEqual({ done: false, count: 0, labels: [] });
    expect(after.modifiedAt).toBe(before.modifiedAt);
  });
});

describe('garbledKey', () => {
  // 2026-10-18: a capture's `generated:` map reached disk as this string.
  it('finds a map something stringified, alone or in a list', () => {
    expect(garbledKey({ type: 'Risk', generated: '[object Object]' })).toBe('generated');
    expect(garbledKey({ verified: ['[object Object]'] })).toBe('verified');
  });

  it('passes real values, maps included', () => {
    expect(
      garbledKey({
        generated: { by: 'claude-code', at: '2026-07-28T16:42:00Z' },
        tags: ['work'],
        status: 'open',
        done: null,
      }),
    ).toBeNull();
    expect(garbledKey({ note: 'an [object Object] inside a sentence' })).toBeNull();
  });
});
