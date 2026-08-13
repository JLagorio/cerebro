/**
 * Golden replay, TS side (M24.1).
 *
 * The SAME fixture files `cargo test` replays, asserted through the TS
 * interpreter over the SAME shared table. This is the milestone's parity
 * mechanism: two interpreters, one artifact, one fixture set. Nobody reviews
 * a hand-copied rule for equivalence, because there is no hand-copied rule.
 *
 * A fixture marked `rust_only` depends on CAS, support-graph ancestry, or
 * logical-batch semantics that are out of the mock's scope by declaration
 * (D5). Its verdict replay is SKIPPED loudly here, never quietly omitted from
 * the directory — and the assertions below still run over it, because what
 * they check is the ARTIFACT: that the op declares the code possible, and
 * that the code declares a destiny. That half of parity does not need a
 * second interpreter.
 *
 * @see src-tauri/src/policy/goldens.rs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  op as opRule,
  parseTable,
  POLICY,
  transitionFor,
  type Destiny,
  type PolicyTable,
  type Risk,
} from './table';
import { tableVerdict, verdictEscalators, verdictRisk, type ProposalFacts } from './verdict';

const GOLDENS_DIR = join(__dirname, '../../../shared/policy/goldens');
const REPO = join(__dirname, '../../..');

/** The frozen table a fixture named, parsed from the same bytes Rust reads. */
function frozen(name: string): PolicyTable {
  if (name !== 'v1' && name !== 'v2') {
    throw new Error(`${name} is not a frozen policy table — the committed ones are v1 and v2`);
  }
  return parseTable(
    JSON.parse(readFileSync(join(REPO, `shared/policy/policy.${name}.json`), 'utf8')),
  );
}

/** The table a fixture is asserted against: the one it named, or the shipped one. */
function tableOf(golden: Golden): PolicyTable {
  return golden.table === undefined ? POLICY : frozen(golden.table);
}

type GoldenSignal = { flag: boolean } | { count: number };

interface Golden {
  name: string;
  why: string;
  rust_only?: boolean;
  signals?: Record<string, GoldenSignal>;
  /**
   * `"<class>/<id>" -> version`. A fixture that declares a world is
   * asserting expected-version CAS, which is Rust-only by declaration (D5) —
   * so it must also be `rust_only`, and the test below proves it is.
   */
  versions?: Record<string, number>;
  /**
   * The support graph the preventive anti-self-ancestry walk runs over
   * (M26.3). Like `versions`, declaring one makes the fixture Rust-only: the
   * walk reads reducer state the mock has no counterpart for.
   */
  ancestry?: {
    belief_revisions?: Record<string, string>;
    derived_from?: Record<string, string[]>;
    lineage?: Record<string, string[]>;
  };
  /**
   * Which committed table this fixture replays against — a frozen one by
   * name (`"v1"`, `"v2"`), or absent for the SHIPPED table.
   *
   * M27.4 made every capability the shipped table declares available, so
   * `capability_unavailable` is unreachable against v3. The frozen artifacts
   * are already this repo's negative controls, and a refusal path with no
   * shared fixture is exactly where two interpreters drift apart unwatched.
   */
  table?: string;
  proposal: Record<string, unknown>;
  expect: {
    verdict: string;
    effective_risk?: Risk | null;
    escalated_by?: string[];
    rejection?: string | null;
    destiny?: Destiny | null;
    review?: string | null;
  };
}

const files = readdirSync(GOLDENS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

function load(file: string): Golden {
  return JSON.parse(readFileSync(join(GOLDENS_DIR, file), 'utf8')) as Golden;
}

/**
 * The table-decidable projection of a fixture's proposal — the same extraction
 * `Golden::facts` performs in Rust, off the frozen ProposalV1 shape.
 */
function facts(golden: Golden, table: PolicyTable = POLICY): ProposalFacts {
  const proposal = golden.proposal as {
    op: { kind: string; payload?: Record<string, unknown> };
    declared_risk: Risk;
    basis: { transition_cause: string };
    targets: { target_class: string }[];
  };
  const payloadConditions: Record<string, string> = {};
  for (const [key, value] of Object.entries(proposal.op.payload ?? {})) {
    if (typeof value === 'string') payloadConditions[key] = value;
  }
  const targetClasses = [...new Set(proposal.targets.map((t) => t.target_class))].sort();
  const transition = transitionFor(table, proposal.op.kind, payloadConditions);
  if (transition === null)
    throw new Error(`${proposal.op.kind}: the payload selects no transition`);
  return {
    op: proposal.op.kind,
    transition,
    declaredRisk: proposal.declared_risk,
    targetClasses,
    transitionCause: proposal.basis.transition_cause,
    payloadConditions,
    signals: golden.signals ?? {},
  };
}

describe('policy goldens replay identically in the TS interpreter', () => {
  it('has fixtures to replay', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const golden = load(file);
    const run = golden.rust_only === true ? it.skip : it;
    run(`${file} — ${golden.why.split('.')[0]}`, () => {
      const against = tableOf(golden);
      const verdict = tableVerdict(against, facts(golden, against));
      expect(verdict.kind).toBe(golden.expect.verdict);
      expect(verdictRisk(verdict)).toBe(golden.expect.effective_risk ?? null);
      expect(verdictEscalators(verdict)).toEqual(golden.expect.escalated_by ?? []);
      const rejection = verdict.kind === 'rejected' ? verdict.rejection : null;
      expect(rejection?.code ?? null).toBe(golden.expect.rejection ?? null);
      expect(rejection?.destiny ?? null).toBe(golden.expect.destiny ?? null);
      const review = verdict.kind === 'queued' ? verdict.review : null;
      expect(review).toBe(golden.expect.review ?? null);
    });
  }
});

describe('the fixture set itself', () => {
  it('names each file after its fixture', () => {
    for (const file of files) {
      expect(`${load(file).name}.json`).toBe(file);
    }
  });

  it('marks every CAS fixture rust_only rather than quietly omitting it', () => {
    // BY DECLARATION, NOT OMISSION. The mock has no `state_versions`, so a
    // fixture that depends on them is skipped out loud in this file rather
    // than missing from the directory.
    const cas = files.filter((f) => Object.keys(load(f).versions ?? {}).length > 0);
    expect(cas.length).toBeGreaterThan(0);
    for (const file of cas) {
      expect(load(file).rust_only, `${file} declares versions`).toBe(true);
    }
  });

  it('marks every self-ancestry fixture rust_only, and still checks their artifact half', () => {
    // The walk is Rust-only, the BINDING is not: these files are what hold
    // the shared table to declaring `self_ancestry` possible for the ops that
    // can produce it, and to routing it at all. Both are asserted below over
    // every file, skipped or not.
    const ancestry = files.filter((f) => load(f).ancestry !== undefined);
    expect(ancestry.length).toBeGreaterThan(0);
    for (const file of ancestry) {
      expect(load(file).rust_only, `${file} declares a support graph`).toBe(true);
    }
    const refusals = ancestry.filter((f) => load(f).expect.rejection === 'self_ancestry');
    expect(refusals.length).toBeGreaterThan(0);
    // And a control, or a gate that refused everything would look identical
    // to one that works.
    expect(ancestry.length).toBeGreaterThan(refusals.length);
  });

  it('declares a destiny with every rejection', () => {
    // The D5 split is the point: a rejection with no declared destiny is
    // exactly the telemetry leak this milestone guards against.
    for (const file of files) {
      const { expect: want } = load(file);
      expect(Boolean(want.rejection)).toBe(Boolean(want.destiny));
    }
  });

  it('exercises every escalator the table declares', () => {
    const fired = new Set(files.flatMap((f) => load(f).expect.escalated_by ?? []));
    for (const escalator of POLICY.escalators) {
      expect(fired.has(escalator.signal)).toBe(true);
    }
  });

  it('exercises both rejection destinies', () => {
    const destinies = new Set(files.map((f) => load(f).expect.destiny).filter(Boolean));
    expect(destinies.has('ledger')).toBe(true);
    expect(destinies.has('operational')).toBe(true);
  });

  it('only asserts rejections the op declares possible', () => {
    for (const file of files) {
      const golden = load(file);
      const code = golden.expect.rejection;
      if (!code) continue;
      const against = tableOf(golden);
      const rule = opRule(against, facts(golden, against).op);
      expect(rule?.possible_rejections).toContain(code);
    }
  });
});
