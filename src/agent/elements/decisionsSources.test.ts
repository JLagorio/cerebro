import { describe, expect, it } from 'vitest';
import { conceptSourceRow, resourceRow } from '@/agent/elements/decisionsSources';

/**
 * A concept's sources as the Sources element's rows (M91.14): where each
 * resource leads is `sourceTarget`'s one rule, and only an http(s) address is
 * ever a link — which the element checks — while a vault page opens in the
 * app (CV-16).
 */

const ENTRIES = [
  { path: 'records/decision.md', title: 'The decision' },
  { path: 'records/untitled.md', title: '' },
];

describe('a concept source', () => {
  it('reads an address by the title it was given, the name its link carries, or nothing', () => {
    expect(resourceRow('https://example.com/a', 'Standup', ENTRIES)).toEqual({
      ref: { kind: 'url', url: 'https://example.com/a', via: 'text', title: 'Standup' },
      page: null,
    });
    expect(
      resourceRow('https://linear.app/acme/issue/ENG-142/fix-login', null, ENTRIES).ref.title,
    ).toBe('ENG-142 Fix login');
    // The element names it by its host.
    expect(resourceRow('https://example.com/a', null, ENTRIES).ref).toEqual({
      kind: 'url',
      url: 'https://example.com/a',
      via: 'text',
    });
  });

  it('keeps any other scheme an address, which the element draws as words', () => {
    for (const resource of ['javascript:alert(1)', 'file:///etc/passwd', 'mailto:a@b.c']) {
      const row = resourceRow(resource, null, ENTRIES);
      expect(row.ref.kind).toBe('url');
      expect(row.page).toBeNull();
    }
  });

  it('opens a vault page a path names, with or without its leading slash', () => {
    for (const resource of ['/records/decision.md', 'records/decision.md']) {
      expect(resourceRow(resource, null, ENTRIES)).toEqual({
        ref: { kind: 'vault', path: 'records/decision.md', via: 'text', title: 'The decision' },
        page: 'records/decision.md',
      });
    }
    // A page with no title is named by its path.
    expect(resourceRow('/records/untitled.md', null, ENTRIES).ref.title).toBeUndefined();
  });

  it('opens nothing for a path no page answers to, or a scope descriptor', () => {
    expect(resourceRow('/records/gone.md', null, ENTRIES)).toEqual({
      ref: { kind: 'vault', path: '/records/gone.md', via: 'text' },
      page: null,
    });
    expect(
      conceptSourceRow({ resource: 'all queries in project X', title: 'Queries' }, ENTRIES),
    ).toEqual({
      ref: { kind: 'vault', path: 'all queries in project X', via: 'text', title: 'Queries' },
      page: null,
    });
  });
});
