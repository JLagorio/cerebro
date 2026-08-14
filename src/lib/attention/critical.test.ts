/**
 * Golden replay, TS side (M27.7).
 *
 * The SAME fixture files `cargo test` replays, asserted through the TS
 * interpreter over the SAME shared artifact. Two interpreters, one artifact,
 * one fixture set — nobody reviews a hand-copied rule for equivalence,
 * because there is no hand-copied rule.
 *
 * @see src-tauri/src/attention/critical.rs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CRITICAL,
  evaluate,
  parseTriggers,
  type Candidate,
  type ReplacementEdge,
} from './critical';

const GOLDENS_DIR = join(__dirname, '../../../shared/policy/goldens-critical');

interface Golden {
  name: string;
  description: string;
  as_of: string;
  candidates: Candidate[];
  replacements?: ReplacementEdge[];
  expected: { trigger_id: string; candidate_id: string }[];
}

const files = readdirSync(GOLDENS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('the critical-attention bypass', () => {
  it('ships the small, complete initial inventory', () => {
    expect(CRITICAL.ruleVersion).toBe('critical-attention-v1');
    expect(CRITICAL.triggers.map((t) => t.id)).toEqual([
      'production_signing_certificate_expired',
      'production_signing_certificate_expiring',
    ]);
  });

  it('gives every shipped trigger its five goldens', () => {
    // Positive, boundary, replaced, wrong-environment, malformed. The same
    // assertion the Rust suite makes, over the same directory — a trigger
    // with no vectors is a rule nobody has to keep.
    for (const trigger of CRITICAL.triggers) {
      for (const shape of ['positive', 'boundary', 'replaced', 'wrong-environment', 'malformed']) {
        expect(files).toContain(`${trigger.id.replaceAll('_', '-')}-${shape}.json`);
      }
    }
  });

  it('has goldens to replay', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  for (const file of files) {
    it(`replays ${file}`, () => {
      const golden = JSON.parse(readFileSync(join(GOLDENS_DIR, file), 'utf8')) as Golden;
      const fired = evaluate(
        CRITICAL,
        golden.candidates,
        golden.replacements ?? [],
        Date.parse(golden.as_of),
      ).map((f) => ({ trigger_id: f.trigger_id, candidate_id: f.candidate_id }));
      expect(fired, `${golden.name}: ${golden.description}`).toEqual(golden.expected);
    });
  }

  it('refuses a replacement direction it does not speak', () => {
    // Read backwards, a supersedes would silence exactly the certificate that
    // still needs rotating. Both loaders refuse rather than guess.
    expect(() =>
      parseTriggers({
        ...(CRITICAL as unknown as Record<string, unknown>),
        format: 1,
        rule_version: 'x',
        replacement: { relation: 'supersedes', direction: 'candidate_from_replacement_to' },
        triggers: CRITICAL.triggers,
      }),
    ).toThrow(/direction/);
  });

  it('refuses an empty trigger list rather than reading as a quiet base', () => {
    expect(() =>
      parseTriggers({
        format: 1,
        artifact_version: 1,
        rule_version: 'x',
        replacement: CRITICAL.replacement,
        triggers: [],
      }),
    ).toThrow(/indistinguishable/);
  });

  it('refuses a condition on a field the trigger does not require', () => {
    expect(() =>
      parseTriggers({
        format: 1,
        artifact_version: 1,
        rule_version: 'x',
        replacement: CRITICAL.replacement,
        triggers: [
          {
            id: 't',
            copy_key: 'k',
            required_fields: [{ field: 'kind', type: 'string' }],
            conditions: [{ field: 'expires_at', operator: 'lte', of: 'as_of', plus_seconds: 0 }],
          },
        ],
      }),
    ).toThrow(/does not require/);
  });
});
