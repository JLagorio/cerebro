/**
 * The policy table, TS side (M24.1) — byte identity with Rust, and the same
 * strict load refusals.
 *
 * @see src-tauri/src/policy/table.rs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../sha256';
import {
  ALL_STAGES,
  blockingCapability,
  destiny,
  parseTable,
  POLICY,
  POLICY_V1_DIGEST_PATH,
  POLICY_V1_PATH,
  transitionFor,
  type PolicyTable,
} from './table';

const REPO = join(__dirname, '../../..');
const RAW = readFileSync(join(REPO, POLICY_V1_PATH), 'utf8');

describe('the shared artifact is one artifact', () => {
  it('hashes to the digest the Rust core also asserts', () => {
    // THE cross-language anchor. Rust hashes what `include_str!` compiled in
    // and compares against this same file; if the two languages ever load
    // different bytes, both disagree with the digest instead of quietly
    // drifting apart. Regenerate deliberately after a table edit with
    // `cargo test --lib policy::table::tests::write_policy_digest -- --ignored`.
    const committed = readFileSync(join(REPO, POLICY_V1_DIGEST_PATH), 'utf8').trim();
    expect(sha256Hex(RAW)).toBe(committed);
  });

  it('is the same object vite imported, not a copy in src/', () => {
    expect(JSON.parse(RAW)).toEqual(POLICY);
  });

  it('validates on load', () => {
    expect(POLICY.format).toBe(1);
    expect(Object.keys(POLICY.ops).length).toBeGreaterThan(0);
  });
});

/** A structurally edited copy of the shipped table. */
function mutated(f: (table: PolicyTable) => void): unknown {
  const copy = JSON.parse(RAW) as PolicyTable;
  f(copy);
  return copy;
}

describe('load refuses an artifact it cannot fully understand', () => {
  // Each of these has a counterpart in table.rs. A silently dropped rule
  // reads as permission, so there is no "skip the row we did not recognise"
  // path on either side.

  it('refuses an unknown predicate', () => {
    const raw = mutated((t) => {
      t.ops.promote_draft.requires = [...t.ops.promote_draft.requires, 'zzz_invented'].sort();
    });
    expect(() => parseTable(raw)).toThrow(/zzz_invented/);
  });

  it('refuses an unknown transition', () => {
    const raw = mutated((t) => {
      t.ops.promote_draft.allowed_transitions = ['teleport'];
    });
    expect(() => parseTable(raw)).toThrow(/teleport/);
  });

  it('refuses an unknown target class', () => {
    const raw = mutated((t) => {
      t.ops.promote_draft.target_classes = ['belief', 'vibe'];
    });
    expect(() => parseTable(raw)).toThrow(/vibe/);
  });

  it('refuses a rejection code missing from the global registry', () => {
    const raw = mutated((t) => {
      t.ops.promote_draft.possible_rejections = [
        ...t.ops.promote_draft.possible_rejections,
        'just_because',
      ].sort();
    });
    expect(() => parseTable(raw)).toThrow(/just_because/);
  });

  it('refuses an escalator pointing at no threshold', () => {
    const raw = mutated((t) => {
      t.escalators[1].above = 'lineage_fan_in_enormous';
    });
    expect(() => parseTable(raw)).toThrow(/unknown threshold/);
  });

  it('refuses an unsorted closed list', () => {
    // Sorting is not cosmetics: two tables that mean the same thing must not
    // be able to differ, or the byte-identity check is theatre.
    const raw = mutated((t) => {
      t.target_classes = ['observation', 'belief', 'entity'];
    });
    expect(() => parseTable(raw)).toThrow(/not sorted/);
  });

  it('refuses a capability-gated op that cannot report capability_unavailable', () => {
    const raw = mutated((t) => {
      t.ops.classify_conflict.possible_rejections =
        t.ops.classify_conflict.possible_rejections.filter((c) => c !== 'capability_unavailable');
    });
    expect(() => parseTable(raw)).toThrow(/capability_unavailable/);
  });

  it('refuses an evaluation order missing a stage', () => {
    const raw = mutated((t) => {
      t.evaluation_order = t.evaluation_order.filter((s) => s !== 'silence');
    });
    expect(() => parseTable(raw)).toThrow(/omits silence/);
  });

  it('refuses a multi-transition op with no selector', () => {
    const raw = mutated((t) => {
      delete t.ops.edit_relation.transition_selector;
    });
    expect(() => parseTable(raw)).toThrow(/no transition_selector/);
  });
});

describe('the table answers the questions an interpreter asks', () => {
  it('declares a destiny for every code an op can produce', () => {
    for (const [name, rule] of Object.entries(POLICY.ops)) {
      for (const code of rule.possible_rejections) {
        expect(destiny(POLICY, code), `${name} can produce ${code}`).not.toBeNull();
      }
    }
  });

  it('gates exactly the ops whose machinery has not shipped', () => {
    // M27 owns the conflict classifier; until then the op is typed-unavailable
    // rather than emitting an unnamed mutation.
    expect(blockingCapability(POLICY, 'classify_conflict')).toBe('conflict_classification');
    expect(blockingCapability(POLICY, 'supersede_belief')).toBeNull();
    // M22's subject-correction body, validator, reducer effect, and vectors
    // all landed, so the HIGH correction op is available.
    expect(blockingCapability(POLICY, 'correct_observation_subject')).toBeNull();
  });

  it('selects a transition from the payload only where the table says to', () => {
    expect(transitionFor(POLICY, 'edit_relation', { action: 'add' })).toBe('relation_add');
    expect(transitionFor(POLICY, 'edit_relation', { action: 'remove' })).toBe('relation_remove');
    // A payload that does not decide gets null, never a default.
    expect(transitionFor(POLICY, 'edit_relation', {})).toBeNull();
    expect(transitionFor(POLICY, 'edit_relation', { action: 'sideways' })).toBeNull();
    // Single-transition ops do not consult the payload at all.
    expect(transitionFor(POLICY, 'promote_draft', {})).toBe('qualify');
  });

  it('knows every stage the interpreter implements', () => {
    expect([...POLICY.evaluation_order].sort()).toEqual([...ALL_STAGES].sort());
  });
});
