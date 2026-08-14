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
  FORMAT,
  parseTable,
  POLICY,
  POLICY_DIGEST_PATH,
  POLICY_PATH,
  retryVerdict,
  transitionFor,
  type PolicyTable,
} from './table';

const REPO = join(__dirname, '../../..');
const RAW = readFileSync(join(REPO, POLICY_PATH), 'utf8');
/** The frozen format-1 artifact — still readable, and still not the table. */
const RAW_V1 = readFileSync(join(REPO, 'shared/policy/policy.v1.json'), 'utf8');
const RAW_V2 = readFileSync(join(REPO, 'shared/policy/policy.v2.json'), 'utf8');

describe('the shared artifact is one artifact', () => {
  it('hashes to the digest the Rust core also asserts', () => {
    // THE cross-language anchor. Rust hashes what `include_str!` compiled in
    // and compares against this same file; if the two languages ever load
    // different bytes, both disagree with the digest instead of quietly
    // drifting apart. Regenerate deliberately after a table edit with
    // `cargo test --lib policy::table::tests::write_policy_digest -- --ignored`.
    const committed = readFileSync(join(REPO, POLICY_DIGEST_PATH), 'utf8').trim();
    expect(sha256Hex(RAW)).toBe(committed);
  });

  it('is the same object vite imported, not a copy in src/', () => {
    expect(JSON.parse(RAW)).toEqual(POLICY);
  });

  it('validates on load', () => {
    expect(POLICY.format).toBe(FORMAT);
    expect(Object.keys(POLICY.ops).length).toBeGreaterThan(0);
  });

  it('still reads the frozen format-1 artifact, which binds no ancestry gate', () => {
    // Format 1 is history, and the Rust core keeps it as the negative
    // control for M26.3's registration gate — a table that PARSES and simply
    // predates the binding. Both loaders accept the same set of formats, or
    // "which tables are readable" would have two answers.
    const v1 = parseTable(JSON.parse(RAW_V1));
    expect(v1.format).toBe(1);
    expect(v1.preventive_ancestry).toBeUndefined();
    // And its digest is still the one M24 published: nothing edits it.
    const committed = readFileSync(join(REPO, 'shared/policy/policy.v1.sha256'), 'utf8').trim();
    expect(sha256Hex(RAW_V1)).toBe(committed);
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

  it('refuses a retryable code that is not a code', () => {
    const raw = mutated((t) => {
      t.in_session_retry!.retryable_rejections = [
        ...t.in_session_retry!.retryable_rejections,
        'aardvark_unavailable',
      ].sort();
    });
    expect(() => parseTable(raw)).toThrow(/aardvark_unavailable/);
  });

  it('refuses a table that makes a human decision retryable', () => {
    const raw = mutated((t) => {
      t.in_session_retry!.retryable_rejections = [
        ...t.in_session_retry!.retryable_rejections,
        'human_rejected',
      ].sort();
    });
    expect(() => parseTable(raw)).toThrow(/not a stale precondition/);
  });

  it('refuses zero attempts, which would forbid submitting at all', () => {
    const raw = mutated((t) => {
      t.in_session_retry!.max_attempts = 0;
    });
    expect(() => parseTable(raw)).toThrow(/counts the first attempt/);
  });

  it('refuses a format-2 table with no retry rule', () => {
    const raw = mutated((t) => {
      delete t.in_session_retry;
    });
    expect(() => parseTable(raw)).toThrow(/declares no in_session_retry/);
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

  it('refuses a format it does not know', () => {
    // Widening to a SET is not the same as accepting anything: a table from
    // a build that knew more than this one must refuse, not be read with the
    // fields this build happens to recognise.
    const raw = mutated((t) => {
      t.format = 99;
    });
    expect(() => parseTable(raw)).toThrow(/unsupported policy format 99/);
  });

  it('refuses a format-2 table that binds no ancestry gate', () => {
    // The whole point of the version bump. A v2 that dropped the block would
    // look modern and gate nothing.
    const raw = mutated((t) => {
      delete t.preventive_ancestry;
    });
    expect(() => parseTable(raw)).toThrow(/declares no preventive_ancestry/);
  });

  it('refuses a bound op whose row runs no walk', () => {
    // The binding is three facts that must agree. This is the one that would
    // otherwise ship as protection: the block names the op, and the op's row
    // requires nothing.
    const raw = mutated((t) => {
      t.ops.update_belief.requires = t.ops.update_belief.requires.filter(
        (p) => p !== 'no_self_ancestry',
      );
    });
    expect(() => parseTable(raw)).toThrow(/its row does not/);
  });

  it('refuses a bound op that cannot report the rejection', () => {
    const raw = mutated((t) => {
      t.ops.update_belief.possible_rejections = t.ops.update_belief.possible_rejections.filter(
        (c) => c !== 'self_ancestry',
      );
    });
    expect(() => parseTable(raw)).toThrow(/cannot report/);
  });

  it('refuses an op that runs the walk outside the block', () => {
    // The other direction, and the reason the block is the single answer to
    // "where does the gate run?".
    const raw = mutated((t) => {
      t.ops.contest_belief.requires = [...t.ops.contest_belief.requires, 'no_self_ancestry'].sort();
    });
    expect(() => parseTable(raw)).toThrow(/preventive_ancestry does not list it/);
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

  it('gates nothing this build cannot spell, and still knows how to gate', () => {
    // M27.4 shipped the classifier's body, expansion, reducer effect, and
    // vectors, so nothing the shipped table declares is unavailable — the
    // twin of `a_capability_gated_op_still_has_an_expansion_arm_to_match`.
    expect(blockingCapability(POLICY, 'classify_conflict')).toBeNull();
    expect(blockingCapability(POLICY, 'correct_observation_subject')).toBeNull();
    expect(blockingCapability(POLICY, 'supersede_belief')).toBeNull();
    // The gate is still live code, and the frozen v2 table is where it can be
    // seen firing — the same artifact `classify-conflict-is-not-available-yet`
    // replays against.
    const v2 = parseTable(JSON.parse(RAW_V2));
    expect(blockingCapability(v2, 'classify_conflict')).toBe('conflict_classification');
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

  it('answers retry with three distinct verdicts, and never from a v1 table', () => {
    // The twin of `retry_is_bounded_typed_and_never_granted_by_a_table_that
    // _predates_it` in table.rs, replayed from the same artifact.
    expect(retryVerdict(POLICY, 'stale_target_version', 1)).toBe('retry');
    expect(retryVerdict(POLICY, 'stale_target_version', 3)).toBe('exhausted');
    // Substance, not state: not retryable at any count.
    expect(retryVerdict(POLICY, 'self_ancestry', 0)).toBe('not_retryable');
    expect(retryVerdict(POLICY, 'human_rejected', 0)).toBe('not_retryable');
    // A table that predates the rule grants nothing.
    expect(
      retryVerdict({ ...POLICY, in_session_retry: undefined }, 'stale_target_version', 0),
    ).toBe('not_retryable');
  });

  it('knows every stage the interpreter implements', () => {
    expect([...POLICY.evaluation_order].sort()).toEqual([...ALL_STAGES].sort());
  });

  it('keeps mint-time refusals out of every op row', () => {
    // `semantic_search_unavailable` (M26.2) fails at a fourth place: not the
    // wire, not the ledger writer, and not an op's policy evaluation — the
    // server could not run retrieval, so no proposal was ever built. An op
    // that listed it would be claiming it can produce a refusal that happens
    // before it exists.
    expect(POLICY.mint_rejections).toEqual(['semantic_search_unavailable']);
    expect(destiny(POLICY, 'semantic_search_unavailable')).toBe('operational');
    for (const [name, rule] of Object.entries(POLICY.ops)) {
      expect(rule.possible_rejections, `${name}`).not.toContain('semantic_search_unavailable');
    }
  });

  it('binds the preventive ancestry walk to the ops that change a belief basis', () => {
    // The walk is Rust-only — it reads reducer state the mock has no
    // counterpart for — but WHERE it runs is policy, and both loaders hold
    // the artifact to the same three-way agreement. `ancestry.rs` asserts
    // this same list against `basis_target`'s exhaustive match.
    const ancestry = POLICY.preventive_ancestry;
    expect(ancestry?.required_for_ops).toEqual(['create_belief', 'update_belief']);
    expect(ancestry?.predicate).toBe('no_self_ancestry');
    expect(ancestry?.rejection).toBe('self_ancestry');
    expect(destiny(POLICY, 'self_ancestry')).toBe('ledger');
    // The last reserved-but-unbound code became a bound one.
    expect(POLICY.unbound_rejections).toEqual([]);
  });
});
