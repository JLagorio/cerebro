/**
 * Golden replay, TS side (M24.1).
 *
 * The SAME fixture files `cargo test` replays, asserted through the TS
 * interpreter over the SAME shared table. This is the milestone's parity
 * mechanism: two interpreters, one artifact, one fixture set. Nobody reviews
 * a hand-copied rule for equivalence, because there is no hand-copied rule.
 *
 * A fixture marked `rust_only` depends on CAS or logical-batch semantics that
 * are out of the mock's scope by declaration (D5). It is SKIPPED loudly here,
 * never quietly omitted from the directory.
 *
 * @see src-tauri/src/policy/goldens.rs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { op as opRule, POLICY, transitionFor, type Destiny, type Risk } from './table';
import { tableVerdict, verdictEscalators, verdictRisk, type ProposalFacts } from './verdict';

const GOLDENS_DIR = join(__dirname, '../../../shared/policy/goldens');

type GoldenSignal = { flag: boolean } | { count: number };

interface Golden {
  name: string;
  why: string;
  rust_only?: boolean;
  signals?: Record<string, GoldenSignal>;
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
function facts(golden: Golden): ProposalFacts {
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
  const transition = transitionFor(POLICY, proposal.op.kind, payloadConditions);
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
      const verdict = tableVerdict(POLICY, facts(golden));
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
      const rule = opRule(POLICY, facts(golden).op);
      expect(rule?.possible_rejections).toContain(code);
    }
  });
});
