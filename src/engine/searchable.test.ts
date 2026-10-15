import { describe, expect, it } from 'vitest';
import SEARCHABLE from '../../src-tauri/fixtures/searchable-values.json';
import { PAGE_CHROME_KEYS } from './pageChrome';
import { searchableFields, searchableValues } from './searchable';
import type { Entry } from './types';

/**
 * src-tauri/fixtures/searchable-values.json holds the one rule for what of a
 * note's frontmatter keyword search reads. Rust's
 * `searchable_fields_replay_the_shared_cases` replays the same file, so a
 * database view's search and the agent's search_notes cannot drift apart.
 */
describe('searchable frontmatter (M59.2)', () => {
  it('drops exactly the page chrome keys pageChrome names', () => {
    expect(SEARCHABLE.format).toBe(1);
    expect(SEARCHABLE.chrome_keys).toEqual([...PAGE_CHROME_KEYS]);
  });

  for (const c of SEARCHABLE.values) {
    it(`value: ${c.why}`, () => {
      expect(searchableValues(c.value)).toEqual(c.texts);
    });
  }

  for (const c of SEARCHABLE.entries) {
    it(`entry: ${c.why}`, () => {
      const entry = {
        title: c.title,
        type: c.type,
        properties: c.properties as Entry['properties'],
        relationships: c.relationships as Entry['relationships'],
      };
      expect(searchableFields(entry)).toEqual(c.fields);
    });
  }
});
