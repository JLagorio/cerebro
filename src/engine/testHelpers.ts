import type { Entry } from './types';

type EntryPatch = Partial<Omit<Entry, 'properties'>> & {
  /**
   * Loosened to `unknown` values so tests can pass nested mappings
   * (`fields`, `statuses`) exactly the way the Rust parser stores them
   * in `properties` as raw JSON values.
   */
  properties?: Record<string, unknown>;
};

export function makeEntry(patch: EntryPatch = {}): Entry {
  const { properties, ...rest } = patch;
  return {
    path: 'items/item.md',
    filename: 'item.md',
    folder: 'items',
    project: null,
    title: 'Item',
    type: null,
    properties: (properties ?? {}) as Entry['properties'],
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-24T00:00:00.000Z',
    modifiedAt: '2026-07-24T00:00:00.000Z',
    parseError: null,
    ...rest,
  };
}
