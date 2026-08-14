/**
 * Golden replay, TS side (M28.0). The SAME fixture files `cargo test`
 * replays, asserted through the TS interpreter over the SAME shared
 * registry. Two interpreters, one artifact, one fixture set — the codes are
 * the contract, the prose is not.
 *
 * @see src-tauri/src/trigger/evaluation.rs — the Rust runner, case for case.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ALL_CODES, parseEvaluation, Refused, validate, validateParent } from './evaluation';
import { loadRegistry } from './registry';

const GOLDENS_DIR = join(__dirname, '../../../shared/policy/goldens-trigger');

interface Golden {
  name: string;
  description: string;
  record: unknown;
  parent?: unknown;
  expected: 'accepted' | { refused: string };
}

function goldens(): [string, Golden][] {
  return readdirSync(GOLDENS_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(join(GOLDENS_DIR, name), 'utf8')) as Golden]);
}

/** Parse, validate, and — when a parent rides along — check the relation. */
function outcome(golden: Golden): 'accepted' | { refused: string } {
  try {
    const registry = loadRegistry();
    const record = parseEvaluation(golden.record);
    validate(record, registry);
    if (golden.parent !== undefined) {
      const parent = parseEvaluation(golden.parent);
      validate(parent, registry);
      validateParent(record, parent, registry);
    }
    return 'accepted';
  } catch (error) {
    if (error instanceof Refused) return { refused: error.code };
    throw error;
  }
}

describe('the trigger goldens replay through the TS interpreter', () => {
  it('every golden lands on its pinned outcome', () => {
    const all = goldens();
    expect(all.length).toBeGreaterThan(0);
    for (const [name, golden] of all) {
      expect(outcome(golden), `${name} (${golden.name}): ${golden.description}`).toEqual(
        golden.expected,
      );
    }
  });

  it('every refusal code has a golden, and no golden invents one', () => {
    const covered = new Set<string>();
    for (const [name, golden] of goldens()) {
      if (typeof golden.expected === 'object') {
        expect(
          (ALL_CODES as readonly string[]).includes(golden.expected.refused),
          `${name} names ${golden.expected.refused}, which no validator path emits`,
        ).toBe(true);
        covered.add(golden.expected.refused);
      }
    }
    expect([...covered].sort()).toEqual([...ALL_CODES].sort());
  });
});
