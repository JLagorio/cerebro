import { describe, expect, it } from 'vitest';
import { FIELD_KINDS } from '@/engine/types';
import { CREATABLE_PROPERTY_KINDS, PROPERTY_KINDS, kindMeta } from '@/engine/properties';
import { buildSchema } from '@/engine/schema';
import { makeEntry } from '@/test/factories';

/**
 * The registration contract for a field kind (M16.4).
 *
 * There were three hand-maintained copies of this list and only the union was
 * compiler-enforced. Missing the schema.ts copy made `asFieldKind` resolve the
 * kind to `text`, so a declared Select rendered as a text box and the YAML
 * saying otherwise was ignored. Missing the properties.ts copy made `kindMeta`
 * fall through its `?? PROPERTY_KINDS[0]` and give the kind Text's icon.
 *
 * Both are now compile errors. These pin the parts a compiler cannot see.
 */
describe('field kind registration', () => {
  it('describes every declared kind exactly once', () => {
    expect(PROPERTY_KINDS.map((k) => k.kind).sort()).toEqual([...FIELD_KINDS].sort());
  });

  it('gives each kind its own icon and label, not Text as a fallback', () => {
    for (const kind of FIELD_KINDS) {
      const meta = kindMeta(kind);
      expect(meta.kind).toBe(kind);
      if (kind !== 'text') {
        expect(meta.icon).not.toBe(kindMeta('text').icon);
      }
    }
  });

  it('gives each kind a distinct label', () => {
    const labels = PROPERTY_KINDS.map((k) => k.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  // The schema.ts trap: a kind the parser does not recognise becomes `text`,
  // and nothing anywhere says so.
  it('parses every declared kind off a type doc without downgrading it', () => {
    for (const kind of FIELD_KINDS) {
      const schema = buildSchema([
        makeEntry({
          path: 'types/thing.md',
          filename: 'thing.md',
          title: 'Thing',
          type: 'Type',
          properties: { fields: { probe: { kind } } },
        }),
      ]);
      expect(schema.types.get('Thing')?.fields.find((f) => f.name === 'probe')?.kind).toBe(kind);
    }
  });

  it('offers every non-legacy kind in the add-property catalog', () => {
    const creatable = CREATABLE_PROPERTY_KINDS.map((k) => k.kind);
    const legacy = PROPERTY_KINDS.filter((k) => k.legacy === true).map((k) => k.kind);
    expect(creatable).toEqual(PROPERTY_KINDS.filter((k) => k.legacy !== true).map((k) => k.kind));
    for (const kind of legacy) expect(creatable).not.toContain(kind);
  });

  it('marks exactly the derived kinds computed', () => {
    // A computed kind has no user-editable value, so every surface locks it.
    const computed = PROPERTY_KINDS.filter((k) => k.computed)
      .map((k) => k.kind)
      .sort();
    expect(computed).toEqual(['created_time', 'last_edited_time', 'rollup']);
  });
});
