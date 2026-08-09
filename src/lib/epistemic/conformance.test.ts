/**
 * Conformance replay (M22.4): the TS reducer runs every committed vector in
 * root `conformance/` and must land on the identical state and refusals the
 * Rust reference generated. Refusal identity is (seq, event_id, batch_id,
 * code); details are prose.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { Json } from './ids';
import {
  attestedContentHash,
  canonicalJson,
  deriveRelationId,
  deriveSourceId,
  deriveSourceKey,
  migrateId,
} from './ids';
import { normalizeAliasV1 } from './normalize';
import { project } from './project';
import { reduce, vectorState, type VectorFrame } from './reduce';
import { registrationIdentity, type JsonObject } from './schema';

const CONFORMANCE_DIR = join(__dirname, '../../../conformance');

interface Vector {
  name: string;
  store_id: string;
  events: VectorFrame[];
  expected_state: Json;
  expected_refusals: {
    seq: number;
    event_id: string;
    batch_id: string | null;
    code: string;
  }[];
}

const scenarioFiles = readdirSync(CONFORMANCE_DIR)
  .filter((f) => f.endsWith('.json') && f !== 'derivations.json')
  .sort();

describe('conformance vectors replay identically in the TS reducer', () => {
  it('has vectors to replay', () => {
    expect(scenarioFiles.length).toBeGreaterThanOrEqual(13);
  });

  for (const file of scenarioFiles) {
    it(`replays ${file}`, () => {
      const vector = JSON.parse(
        readFileSync(join(CONFORMANCE_DIR, file), 'utf8'),
      ) as unknown as Vector;
      const state = reduce(vector.events, vector.store_id);
      expect(vectorState(state)).toEqual(vector.expected_state);
      const refusals = state.anomalies.map((a) => ({
        seq: a.seq,
        event_id: a.event_id,
        batch_id: a.batch_id,
        code: a.code,
      }));
      const expected = vector.expected_refusals.map((r) => ({
        seq: r.seq,
        event_id: r.event_id,
        batch_id: r.batch_id,
        code: r.code,
      }));
      expect(refusals).toEqual(expected);
    });
  }
});

describe('shared derivations agree byte-for-byte', () => {
  const data = JSON.parse(
    readFileSync(join(CONFORMANCE_DIR, 'derivations.json'), 'utf8'),
  ) as unknown as {
    store_id: string;
    normalize_alias_v1: { input: string; normalized: string }[];
    relation_ids: { from: string; to: string; relation: string; relation_id: string }[];
    sources: { kind: string; source_key: string; source_id: string }[];
    migrate_ids: { class: string; identity: string; id: string }[];
    attested_content: { content: string; fields: JsonObject; projected: string; hash: string }[];
  };

  it('normalize_alias_v1 matches on every pinned vector', () => {
    for (const { input, normalized } of data.normalize_alias_v1) {
      expect(normalizeAliasV1(input)).toBe(normalized);
    }
  });

  it('relation ids derive identically', () => {
    for (const { from, to, relation, relation_id } of data.relation_ids) {
      expect(deriveRelationId(from, to, relation)).toBe(relation_id);
    }
  });

  it('source keys and store-scoped source ids derive identically', () => {
    // The key's identity object is reconstructible from the key vector via
    // the registration fixtures the Rust side used; here we verify the id
    // half exactly and the key structure (kind prefix + sha256 hex).
    for (const { kind, source_key, source_id } of data.sources) {
      expect(source_key.startsWith(`${kind}:`)).toBe(true);
      expect(deriveSourceId(data.store_id, source_key)).toBe(source_id);
    }
    // And the full key derivation on a known identity: the human fixture.
    const humanKey = deriveSourceKey('human_actor', { actor_id: 'human:josef' });
    expect(data.sources[0].source_key).toBe(humanKey);
    expect(registrationIdentity({ kind: 'human_actor', actor_id: 'human:josef' })).toEqual({
      actor_id: 'human:josef',
    });
  });

  it('migrate ids derive identically', () => {
    for (const { class: klass, identity, id } of data.migrate_ids) {
      expect(migrateId(data.store_id, klass, identity)).toBe(id);
    }
  });

  it('projection and attested-content hashing agree byte-for-byte', () => {
    for (const { content, fields, projected, hash } of data.attested_content) {
      const rendered = project(content, fields as Json);
      expect(rendered).toBe(projected);
      expect(attestedContentHash(rendered)).toBe(hash);
    }
  });

  it('canonical JSON is key-order-preserving and byte-compatible', () => {
    // The digest layer depends on JSON.parse/stringify reproducing serde's
    // bytes for vector frames — spot-check against a committed frame line.
    const vector = JSON.parse(
      readFileSync(join(CONFORMANCE_DIR, 'batches.json'), 'utf8'),
    ) as unknown as Vector;
    const frame = vector.events[0] as unknown as Json;
    const line = canonicalJson(frame);
    expect(line.startsWith('{"v":0,"seq":1,')).toBe(true);
  });
});
