/**
 * The field-kind table, TS side (M60.3): byte identity with Rust, every
 * shared case replayed through the readers the app uses (validateValue,
 * buildSchema, the status chain, optionId, humanize, fieldValue), the
 * tripwires that hold the TS literal unions to the artifact, and the same
 * refusals.
 *
 * @see shared/schema/field-kinds.v1.json
 * @see src-tauri/src/vault/schema.rs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/sha256';
import {
  FIELD_KIND_TABLE,
  FIELD_KINDS_DIGEST_PATH,
  FIELD_KINDS_PATH,
  parseFieldKindTable,
} from './fieldKindTable';
import { optionId, ROLLUP_CALCS, validateValue } from './properties';
import { buildSchema, DEFAULT_STATUSES, humanize, VIRTUAL_FIELDS } from './schema';
import { makeEntry } from './testHelpers';
import { FIELD_KINDS, FILTER_FAMILIES, FILTER_OPS } from './types';
import type { FieldDef, FieldOption, StatusDef } from './types';

const REPO = join(__dirname, '../..');
const RAW = readFileSync(join(REPO, FIELD_KINDS_PATH), 'utf8');
const CASES = FIELD_KIND_TABLE.cases as Record<string, Record<string, unknown>[]>;

const optionJson = (o: FieldOption) => ({
  id: o.id,
  label: o.label,
  color: o.color,
  hollow: o.hollow === true,
});
const statusJson = (s: StatusDef) => ({ ...optionJson(s), group: s.group });

/** A FieldDef as the cases spell it: the parts Rust parses too. */
const defJson = (d: FieldDef) => ({
  kind: d.kind,
  formula: d.formula ?? null,
  options: d.options === undefined ? null : d.options.map(optionJson),
  target: d.target ?? null,
  limit: d.limit ?? null,
  relation: d.relation ?? null,
  property: d.property ?? null,
  calculate: d.calculate ?? null,
  from: d.from ?? null,
});

describe('the shared table is one artifact', () => {
  it('hashes to the digest the Rust reader also asserts', () => {
    // Regenerate deliberately after an edit with
    // `cargo test --lib vault::schema::tests::write_field_kinds_digest -- --ignored`.
    const committed = readFileSync(join(REPO, FIELD_KINDS_DIGEST_PATH), 'utf8').trim();
    expect(sha256Hex(RAW)).toBe(committed);
    expect(JSON.parse(RAW)).toEqual(FIELD_KIND_TABLE);
  });
});

describe('replays the shared cases', () => {
  it('values, through validateValue', () => {
    for (const c of CASES.values) {
      const def = c.def as FieldDef;
      expect(validateValue(def, c.value), String(c.name)).toBe(c.error);
    }
  });

  it('field defs, through buildSchema', () => {
    for (const c of CASES.field_defs) {
      const field = String(c.field);
      const doc = makeEntry({
        path: 'types/t.md',
        title: 'T',
        type: 'Type',
        properties: { fields: { [field]: c.spec } },
      });
      const def = buildSchema([doc]).types.get('T')?.fields[0];
      expect(def === undefined ? null : defJson(def), String(c.name)).toEqual(c.expect);
    }
  });

  it('the status chain, through statusSetFor and statusSourceFor', () => {
    for (const c of CASES.statuses) {
      const entries = (c.entries as Record<string, unknown>[]).map((e) =>
        makeEntry({
          path: e.path as string,
          title: e.title as string,
          type: e.type as string | null,
          project: e.project as string | null,
          properties: e.properties as Record<string, unknown>,
        }),
      );
      const schema = buildSchema(entries);
      const subject = entries.find((e) => e.path === c.subject)!;
      const expected = c.expect as { source: string; statuses: unknown[] };
      expect(schema.statusSourceFor(subject), String(c.name)).toBe(expected.source);
      expect(schema.statusSetFor(subject).map(statusJson), String(c.name)).toEqual(
        expected.statuses,
      );
    }
  });

  it('option ids through optionId, and labels through humanize', () => {
    for (const c of CASES.options) expect(optionId(String(c.label))).toBe(c.id);
    for (const c of CASES.labels) expect(humanize(String(c.id))).toBe(c.label);
  });

  it('precedence, through schema.fieldValue', () => {
    for (const c of CASES.precedence) {
      const raw = c.entry as Record<string, unknown>;
      const entry = makeEntry({
        path: 'records/alpha.md',
        title: raw.title as string,
        type: raw.type as string | null,
        properties: raw.properties as Record<string, unknown>,
        relationships: raw.relationships as Record<string, string[]>,
        createdAt: raw.createdAt as string,
        modifiedAt: raw.modifiedAt as string,
      });
      const entries = [entry];
      if (entry.type !== null) {
        entries.unshift(
          makeEntry({
            path: 'types/t.md',
            title: entry.type,
            type: 'Type',
            properties: { fields: c.fields },
          }),
        );
      }
      const got = buildSchema(entries).fieldValue(entry, String(c.field)) ?? null;
      expect(got, String(c.name)).toEqual(c.expect);
    }
  });
});

describe('the TS literal unions equal the artifact, in order', () => {
  it('FIELD_KINDS', () => {
    expect([...FIELD_KINDS]).toEqual(FIELD_KIND_TABLE.kinds.map((k) => k.kind));
  });

  it('FILTER_OPS', () => {
    expect([...FILTER_OPS]).toEqual(FIELD_KIND_TABLE.filter_ops);
  });

  it('FILTER_FAMILIES', () => {
    expect([...FILTER_FAMILIES]).toEqual(Object.keys(FIELD_KIND_TABLE.filter_families));
  });

  it('the RollupCalc list', () => {
    expect(ROLLUP_CALCS.map((c) => c.calc)).toEqual(
      FIELD_KIND_TABLE.rollup_calcs.map((r) => r.calc),
    );
    expect(ROLLUP_CALCS.filter((c) => c.yieldsNumber).map((c) => c.calc)).toEqual([
      'count',
      'sum',
      'avg',
      'min',
      'max',
      'percent_done',
    ]);
  });

  it('DEFAULT_STATUSES and VIRTUAL_FIELDS', () => {
    expect(DEFAULT_STATUSES.map(statusJson)).toEqual(FIELD_KIND_TABLE.default_statuses);
    expect([...VIRTUAL_FIELDS]).toEqual(FIELD_KIND_TABLE.virtual_fields);
  });
});

describe("refuses malformed tables in Rust's words", () => {
  // JSON.parse's own type: the edits reach arbitrary keys of the artifact.
  const base = () => JSON.parse(RAW);
  const refuse = (edit: (t: ReturnType<typeof base>) => void): string => {
    const t = base();
    edit(t);
    try {
      parseFieldKindTable(t);
    } catch (e) {
      return (e as Error).message;
    }
    return 'accepted';
  };

  it('a kind list that differs from the enum, an unknown atom, a stray operator, a missing message', () => {
    expect(
      refuse((t) => {
        [t.kinds[0], t.kinds[1]] = [t.kinds[1], t.kinds[0]];
      }),
    ).toBe(`field-kinds: kinds must be ${FIELD_KINDS.join(', ')} in order`);
    expect(refuse((t) => (t.kinds[0].accepts = ['string', 'prose']))).toBe(
      'field-kinds: text accepts an unknown atom prose',
    );
    expect(refuse((t) => (t.filter_families.date = ['equals', 'around']))).toBe(
      'field-kinds: date names an operator around that filter_ops lacks',
    );
    expect(refuse((t) => delete t.kinds[8].messages.derived)).toBe(
      'field-kinds: person is missing its derived message',
    );
  });

  it('the format, the rule version, a default status and a collation word', () => {
    expect(refuse((t) => (t.format = 2))).toBe('field-kinds: format must be 1, not 2');
    expect(refuse((t) => (t.rule_version = ' '))).toBe('field-kinds: rule_version is empty');
    expect(refuse((t) => (t.default_statuses[0].group = 'someday'))).toBe(
      'field-kinds: default status backlog has an unknown group someday',
    );
    expect(refuse((t) => (t.default_statuses[1].id = 'backlog'))).toBe(
      'field-kinds: default status backlog is listed twice',
    );
    expect(refuse((t) => (t.collation.sort = 'icu'))).toBe(
      'field-kinds: collation sort has an unknown word icu',
    );
  });
});

it('replays the deadline cases through buildSchema', () => {
  for (const c of FIELD_KIND_TABLE.deadline_cases) {
    const doc = makeEntry({
      path: 'types/task.md',
      type: 'Type',
      title: 'Task',
      properties: { fields: c.fields, deadline: c.deadline },
    });
    expect(buildSchema([doc]).types.get('Task')?.deadline, c.name).toBe(c.expect);
  }
});
