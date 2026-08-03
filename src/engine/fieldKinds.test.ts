import { describe, expect, it } from 'vitest';
import { FIELD_KINDS, type Entry } from '@/engine/types';
import {
  CREATABLE_PROPERTY_KINDS,
  GROUPABLE_KINDS,
  ORDERABLE_KINDS,
  PROPERTY_KINDS,
  coerceValueToKind,
  kindMeta,
  validateValue,
} from '@/engine/properties';
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
          // `properties` is typed for scalars, but a Type doc's `fields:` is
          // genuinely a nested mapping — the scanner hands it through as-is.
          properties: { fields: { probe: { kind } } } as unknown as Entry['properties'],
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

/**
 * The registry the COMPILER cannot police (M16.13).
 *
 * `coerceValueToKind` returns `unknown`, and `undefined` is assignable to
 * `unknown` — so a kind added to the union and forgotten in that switch
 * compiled clean. `changeFieldKind` then pushed the undefined through
 * `patchFrontmatter`, which spells undefined as "delete": converting a field
 * to a forgotten kind wiped the value on every record of the type, silently.
 * The switch has a `never` default now; this pins the runtime half.
 */
describe('kind coercion is total', () => {
  it('returns a value, never undefined, for every declared kind', () => {
    for (const kind of FIELD_KINDS) {
      expect(coerceValueToKind('some text', kind)).not.toBeUndefined();
      expect(coerceValueToKind(['a', 'b'], kind)).not.toBeUndefined();
      expect(coerceValueToKind(42, kind)).not.toBeUndefined();
    }
  });
});

/**
 * Grouping and sorting are FLAGS on the kind now (M16.13). They were two
 * hand-written `Set<string>` pairs — ViewToolbar exported one and
 * ViewSettingsPanel kept a verbatim copy — so deleting from one produced no
 * compile error and no failing test, and the two surfaces could disagree.
 */
describe('kind capabilities', () => {
  it('answers groupable and orderable for every kind', () => {
    for (const kind of FIELD_KINDS) {
      expect(typeof kindMeta(kind).groupable).toBe('boolean');
      expect(typeof kindMeta(kind).orderable).toBe('boolean');
    }
  });

  it('derives the two sets from that one answer', () => {
    expect([...GROUPABLE_KINDS].sort()).toEqual(
      FIELD_KINDS.filter((k) => kindMeta(k).groupable).sort(),
    );
    expect([...ORDERABLE_KINDS].sort()).toEqual(
      FIELD_KINDS.filter((k) => kindMeta(k).orderable).sort(),
    );
  });

  // The behaviour those Sets encoded, so the migration is provably faithful.
  it('keeps what the hand-written sets said', () => {
    for (const k of [
      'status',
      'select',
      'multiselect',
      'person',
      'checkbox',
      'relation',
    ] as const) {
      expect(GROUPABLE_KINDS.has(k)).toBe(true);
    }
    for (const k of ['status', 'select', 'number', 'date', 'daterange'] as const) {
      expect(ORDERABLE_KINDS.has(k)).toBe(true);
    }
    expect(GROUPABLE_KINDS.has('text')).toBe(false);
    expect(ORDERABLE_KINDS.has('files')).toBe(false);
  });
});

/** M16.13 — Email and Phone. */
describe('email and phone', () => {
  it('are creatable kinds with their own icons', () => {
    for (const kind of ['email', 'phone'] as const) {
      expect(FIELD_KINDS).toContain(kind);
      expect(CREATABLE_PROPERTY_KINDS.map((k) => k.kind)).toContain(kind);
      expect(kindMeta(kind).icon).not.toBe(kindMeta('text').icon);
    }
  });

  // Shape only. Refusing a frontmatter write is a worse failure than an
  // address that will not linkify, and Notion does not validate either.
  it('accept any text rather than enforcing a pattern', () => {
    expect(validateValue({ name: 'e', kind: 'email' }, 'not an address')).toBeNull();
    expect(validateValue({ name: 'p', kind: 'phone' }, 'ext. 4021')).toBeNull();
    expect(validateValue({ name: 'e', kind: 'email' }, 42)).toMatch(/text/);
  });
});
