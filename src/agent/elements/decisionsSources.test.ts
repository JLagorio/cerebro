import { describe, expect, it } from 'vitest';
import { conceptSourceRow, resourceRow } from '@/agent/elements/decisionsSources';
import resourceCases from '../../../shared/knowledge/resource-target-cases.v1.json';

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
    const web = resourceRow('https://example.com/a', 'Standup', ENTRIES);
    expect(web.ref).toEqual({
      kind: 'url',
      url: 'https://example.com/a',
      via: 'text',
      title: 'Standup',
    });
    expect(web.page).toBeNull();
    expect(
      resourceRow('https://linear.app/acme/issue/ENG-142/fix-login', null, ENTRIES).ref?.title,
    ).toBe('ENG-142 Fix login');
    // The element names it by its host.
    expect(resourceRow('https://example.com/a', null, ENTRIES).ref).toEqual({
      kind: 'url',
      url: 'https://example.com/a',
      via: 'text',
    });
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'mailto:a@b.c',
    'https://user:secret@example.com/report',
    'https://example.com/re\nport',
    '//example.com/report',
  ])('keeps unsafe address %s literal without manufacturing a SourceRef', (resource) => {
    const row = resourceRow(resource, null, ENTRIES);
    expect(row.ref).toBeNull();
    expect(row.page).toBeNull();
    expect(row).toMatchObject({ label: resource });
  });

  it('opens a vault page a path names, with or without its leading slash', () => {
    for (const resource of ['/records/decision.md', 'records/decision.md']) {
      const row = resourceRow(resource, null, ENTRIES);
      expect(row.ref).toEqual({
        kind: 'vault',
        path: 'records/decision.md',
        via: 'text',
        title: 'The decision',
      });
      expect(row.page).toBe('records/decision.md');
    }
    // A page with no title is named by its path.
    expect(resourceRow('/records/untitled.md', null, ENTRIES).ref?.title).toBeUndefined();
  });

  it('opens nothing for a path no page answers to, or a scope descriptor', () => {
    expect(resourceRow('/records/gone.md', null, ENTRIES)).toMatchObject({
      ref: null,
      page: null,
      label: '/records/gone.md',
    });
    expect(
      conceptSourceRow({ resource: 'all queries in project X', title: 'Queries' }, ENTRIES),
    ).toMatchObject({
      ref: null,
      page: null,
      label: 'Queries',
    });
  });

  it('preserves an untitled descriptor literally without asserting absence or a read', () => {
    expect(resourceRow('all queries in project X', null, ENTRIES)).toMatchObject({
      ref: null,
      page: null,
      label: 'all queries in project X',
    });
  });
});

describe('resource adapter shared cases', () => {
  it.each(resourceCases.cases)('$id', (testCase) => {
    const row = resourceRow(testCase.resource, null, resourceCases.entries);
    expect(row.target).toEqual(testCase.target);
    expect(row.ref?.kind ?? null).toBe(testCase.refKind);
    if (row.ref === null) {
      expect(row.page).toBeNull();
      expect(row.label).toBe(testCase.resource);
      expect(row.resource).toBe(testCase.resource);
    } else {
      // A classification is neither a read receipt nor a supporting judgment.
      expect(row.ref.via).toBe('text');
      if (row.ref.kind === 'vault') {
        expect({ internal: row.ref.path }).toEqual(testCase.projection);
        expect(row.page).toBe(row.ref.path);
      } else {
        expect({ external: row.ref.url }).toEqual(testCase.projection);
        expect(row.page).toBeNull();
      }
    }
  });
});
