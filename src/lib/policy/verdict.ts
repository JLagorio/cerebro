/**
 * Effective risk + the table-decidable verdict, TS side (M24.1).
 *
 * The mirror of `src-tauri/src/policy/risk.rs` and `verdict.rs`, and like them
 * it names no op, risk, threshold, or rejection code: base risk, escalators,
 * thresholds, stage order, capability gates, and destinies all come off the
 * shared artifact. The two implementations are held together by the goldens in
 * `shared/policy/goldens/`, replayed by `cargo test` and `pnpm test:run` from
 * the same files.
 *
 * CAS and logical-batch semantics are deliberately Rust-only (D5); goldens that
 * depend on them are marked `rust_only` rather than faked here.
 */

import {
  blockingCapability,
  destiny as destinyOf,
  op as opRule,
  riskRank,
  threshold as thresholdOf,
  type Destiny,
  type PolicyTable,
  type Risk,
} from './table';

/** A derived, server-owned escalator signal. */
export type SignalValue = { flag: boolean } | { count: number };
export type Signals = Record<string, SignalValue>;

export interface EffectiveRisk {
  risk: Risk;
  base: Risk;
  declared: Risk;
  fired: string[];
}

export interface Rejection {
  code: string;
  destiny: Destiny;
}

export type Verdict =
  | { kind: 'applied'; risk: EffectiveRisk }
  | { kind: 'queued'; risk: EffectiveRisk; review: string | null }
  | { kind: 'rejected'; rejection: Rejection; risk: EffectiveRisk | null };

export interface ProposalFacts {
  op: string;
  transition: string;
  declaredRisk: Risk;
  targetClasses: string[];
  transitionCause: string;
  /** Payload discriminators a conditional capability or selector may match. */
  payloadConditions: Record<string, string>;
  /** Already folded across targets: flags OR-ed, counts maxed. */
  signals: Signals;
}

export type RiskRefusal =
  | { kind: 'unknown_op'; op: string }
  | { kind: 'risk_lowered'; base: Risk; declared: Risk }
  | { kind: 'unknown_threshold'; key: string };

function maxRisk(a: Risk, b: Risk): Risk {
  return riskRank(a) >= riskRank(b) ? a : b;
}

function fires(
  table: PolicyTable,
  escalator: { signal: string; above?: string },
  signals: Signals,
) {
  const value = signals[escalator.signal];
  if (value === undefined) return false;
  if (escalator.above !== undefined) {
    if (!('count' in value)) return false;
    const limit = thresholdOf(table, escalator.above);
    if (limit === null) throw { kind: 'unknown_threshold', key: escalator.above } as RiskRefusal;
    // Strictly above: at the threshold is not over it.
    return value.count > limit;
  }
  return 'flag' in value ? value.flag : false;
}

export function effectiveRisk(
  table: PolicyTable,
  name: string,
  declared: Risk,
  signals: Signals,
): EffectiveRisk {
  const rule = opRule(table, name);
  if (!rule) throw { kind: 'unknown_op', op: name } as RiskRefusal;
  const base = rule.base_risk;
  // Agent-declared risk may only RAISE. Understating is refused, not clamped.
  if (riskRank(declared) < riskRank(base)) {
    throw { kind: 'risk_lowered', base, declared } as RiskRefusal;
  }
  let risk = maxRisk(base, declared);
  const fired: string[] = [];
  for (const escalator of table.escalators) {
    if (fires(table, escalator, signals)) {
      risk = maxRisk(risk, escalator.floor);
      fired.push(escalator.signal);
    }
  }
  return { risk, base, declared, fired };
}

export type FactsError =
  | { kind: 'unknown_op'; op: string }
  | { kind: 'transition_not_allowed'; op: string; transition: string }
  | { kind: 'unknown_threshold'; key: string };

function reject(table: PolicyTable, code: string): Rejection {
  const where = destinyOf(table, code);
  /* istanbul ignore next -- table load proved every code has a destiny */
  if (where === null) throw new Error(`no destiny declared for ${code}`);
  return { code, destiny: where };
}

/** The capability blocking this proposal: the op's own gate, then any
 * conditional entry whose full condition matches the payload. */
function blockedBy(table: PolicyTable, facts: ProposalFacts): string | null {
  const direct = blockingCapability(table, facts.op);
  if (direct !== null) return direct;
  for (const conditional of table.conditional_capabilities) {
    if (conditional.op !== facts.op) continue;
    const matches = Object.entries(conditional.when).every(
      ([key, want]) => facts.payloadConditions[key] === want,
    );
    if (!matches) continue;
    const capability = table.capabilities[conditional.capability];
    if (capability !== undefined && !capability.available) return conditional.capability;
  }
  return null;
}

/** Decide everything the artifact alone can decide. */
export function tableVerdict(table: PolicyTable, facts: ProposalFacts): Verdict {
  const rule = opRule(table, facts.op);
  if (!rule) throw { kind: 'unknown_op', op: facts.op } as FactsError;
  if (!rule.allowed_transitions.includes(facts.transition)) {
    throw {
      kind: 'transition_not_allowed',
      op: facts.op,
      transition: facts.transition,
    } as FactsError;
  }

  let risk: EffectiveRisk | null = null;
  for (const stage of table.evaluation_order) {
    if (stage === 'capability') {
      if (blockedBy(table, facts) !== null) {
        return { kind: 'rejected', rejection: reject(table, 'capability_unavailable'), risk };
      }
    } else if (stage === 'target_class') {
      if (facts.targetClasses.some((cls) => !rule.target_classes.includes(cls))) {
        return { kind: 'rejected', rejection: reject(table, 'target_set_mismatch'), risk };
      }
    } else if (stage === 'risk_declaration') {
      try {
        risk = effectiveRisk(table, facts.op, facts.declaredRisk, facts.signals);
      } catch (e) {
        const refusal = e as RiskRefusal;
        if (refusal.kind === 'risk_lowered') {
          return { kind: 'rejected', rejection: reject(table, 'risk_lowered'), risk: null };
        }
        throw refusal as unknown as FactsError;
      }
    } else {
      // Silence may move freshness/coverage/attention and nothing else. The
      // allowlist is the artifact's, so a transition invented later is
      // forbidden here until someone says otherwise in data.
      if (
        table.silence.causes.includes(facts.transitionCause) &&
        !table.silence.allowed_transitions.includes(facts.transition)
      ) {
        return { kind: 'rejected', rejection: reject(table, table.silence.rejection), risk };
      }
    }
  }

  /* istanbul ignore next -- evaluation_order always runs the risk stage */
  if (risk === null) throw new Error('evaluation_order omitted the risk stage');
  const rung = table.risk_ladder[risk.risk];
  return rung.apply === 'auto'
    ? { kind: 'applied', risk }
    : { kind: 'queued', risk, review: rung.review ?? null };
}

export function verdictRisk(verdict: Verdict): Risk | null {
  return verdict.kind === 'rejected' ? (verdict.risk?.risk ?? null) : verdict.risk.risk;
}

export function verdictEscalators(verdict: Verdict): string[] {
  return verdict.kind === 'rejected' ? (verdict.risk?.fired ?? []) : verdict.risk.fired;
}
