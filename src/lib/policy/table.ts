/**
 * `shared/policy/policy.v2.json` — the declarative mutation-governance table,
 * TS side (M24.1, format 2 at M26.3).
 *
 * This is the SAME FILE the Rust core compiles in with `include_str!`, imported
 * verbatim by vite. Nothing here restates a rule: no op name, risk, threshold,
 * rejection code, or destiny is written in TypeScript. What lives in this
 * module is the generic machinery that reads the artifact, plus the same strict
 * load-time validation the Rust loader performs, so a malformed table fails on
 * both sides rather than on whichever one happens to run first.
 *
 * The house rule this file exists under: **a policy rule implemented as twin
 * Rust and TS code is a review-blocking defect.** Parity is the shared artifact
 * plus the shared goldens in `shared/policy/goldens/`. If a rule cannot be
 * expressed in the table, the table format grows.
 *
 * @see src-tauri/src/policy/table.rs — the Rust loader, kind for kind.
 */

import rawTable from '../../../shared/policy/policy.v2.json';

export const POLICY_PATH = 'shared/policy/policy.v2.json';
export const POLICY_DIGEST_PATH = 'shared/policy/policy.v2.sha256';

/** The format this build ships. */
export const FORMAT = 2;

/**
 * Every format this loader can READ. A published artifact is history: format 1
 * was the whole of M24 and M25, and the Rust core still parses it as the
 * negative control for the M26.3 registration gate. The two loaders accept the
 * same set, or "which tables are readable" would be a rule with two answers.
 */
export const SUPPORTED_FORMATS = [1, 2];

export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type Destiny = 'ledger' | 'operational';
export type ApplyMode = 'auto' | 'queued-human-card';

/** Ascending danger — the comparison "declared risk may only RAISE" needs. */
export const RISK_ORDER: Risk[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export function riskRank(risk: Risk): number {
  return RISK_ORDER.indexOf(risk);
}

/**
 * The table-decidable evaluation stages. Precedence between refusals IS
 * policy, so the ORDER comes from the artifact's `evaluation_order`, never
 * from the order of branches in this file.
 */
export type Stage = 'capability' | 'target_class' | 'risk_declaration' | 'silence';
export const ALL_STAGES: Stage[] = ['capability', 'target_class', 'risk_declaration', 'silence'];

export interface LadderRung {
  apply: ApplyMode;
  journal?: boolean;
  review?: string;
}

export interface Escalator {
  signal: string;
  above?: string;
  floor: Risk;
}

export interface Capability {
  available: boolean;
  arrives: string;
}

export interface ConditionalCapability {
  op: string;
  when: Record<string, string>;
  capability: string;
}

export interface TransitionSelector {
  field: string;
  map: Record<string, string>;
}

export interface OpRule {
  target_classes: string[];
  base_risk: Risk;
  revert: 'one_click' | 'none';
  allowed_transitions: string[];
  transition_selector?: TransitionSelector;
  requires: string[];
  requires_capability?: string;
  possible_rejections: string[];
  /**
   * May an AGENT propose this op through the live MCP surface (M26.3c)?
   * Absent means true, so the artifact says only where the answer is NO and a
   * new op is agent-facing unless somebody argues otherwise.
   *
   * `revert_proposal` is the one false today: it is MEDIUM, MEDIUM
   * auto-applies, and an agent-facing revert would silently undo an applied
   * mutation — including one a human had just approved on a HIGH card.
   */
  agent_facing?: boolean;
}

/** The ops an agent may propose, sorted — the registration inventory. */
export function agentFacingOps(table: PolicyTable): string[] {
  return Object.entries(table.ops)
    .filter(([, rule]) => rule.agent_facing !== false)
    .map(([name]) => name)
    .sort();
}

export interface PolicyTable {
  format: number;
  artifact_version: number;
  target_classes: string[];
  predicates: string[];
  transitions: string[];
  rejection_destinies: Record<string, Destiny>;
  /**
   * The `RuleCode` members that are not predicates or transitions. Registered
   * in the artifact so `RuleCode` is validated against it rather than against
   * an enum in each language that would drift.
   */
  rule_codes: string[];
  transport_rejections: string[];
  writer_rejections: string[];
  /**
   * Codes the server returns while MINTING a search receipt, before any
   * proposal exists (M26.2). A fourth category beside transport and writer
   * because it fails at a fourth place: not the wire, not the ledger, and not
   * an op's policy evaluation. Absent in format 1.
   */
  mint_rejections?: string[];
  unbound_rejections: string[];
  evaluation_order: Stage[];
  thresholds: Record<string, number>;
  escalators: Escalator[];
  capabilities: Record<string, Capability>;
  conditional_capabilities: ConditionalCapability[];
  silence: { causes: string[]; allowed_transitions: string[]; rejection: string };
  absence: {
    required_coverage_dimensions: string[];
    receipt_match_fields: string[];
    incomplete_rejection: string;
    mismatch_rejection: string;
  };
  high_stakes: {
    stakes: Risk[];
    queue_rejection: string;
    malformed_rejection: string;
    stale_rejection: string;
  };
  contradiction_addressing: {
    required_for_ops: string[];
    capability: string;
    omitted_rejection: string;
    stale_rejection: string;
  };
  /**
   * The format-2 binding for the preventive anti-self-ancestry walk (M26.3).
   * The walk itself is Rust — it reads reducer state the mock has no
   * counterpart for — but WHERE it runs is policy, so it is data, and this
   * loader holds the artifact to the same three-way agreement the Rust one
   * does. Absent means format 1.
   */
  preventive_ancestry?: {
    required_for_ops: string[];
    predicate: string;
    rejection: string;
  };
  /**
   * When a run may resubmit a refused proposal inside the run it is already
   * paying for (M26.4e). Retryability is policy — a list hand-written here
   * and again in Rust is the twin implementation the artifact prevents.
   * Absent means format 1, and absence is never permission.
   */
  in_session_retry?: {
    max_attempts: number;
    retryable_rejections: string[];
  };
  risk_ladder: Record<Risk, LadderRung>;
  ops: Record<string, OpRule>;
}

/** What a run may do after a typed rejection. */
export type RetryVerdict = 'retry' | 'exhausted' | 'not_retryable';

/**
 * May a run resubmit after this refusal, having already made
 * `attemptsSoFar` attempts on this proposal?
 *
 * Three answers rather than a boolean: "the table says no" and "you have used
 * your attempts" are different sentences, and the window's explanation should
 * say which one happened. The twin of `PolicyTable::retry_verdict`.
 */
export function retryVerdict(
  table: PolicyTable,
  code: string,
  attemptsSoFar: number,
): RetryVerdict {
  const rule = table.in_session_retry;
  if (rule === undefined) return 'not_retryable';
  if (!rule.retryable_rejections.includes(code)) return 'not_retryable';
  return attemptsSoFar >= rule.max_attempts ? 'exhausted' : 'retry';
}

/** Sorted, unique, non-empty — the shape every closed list must have. */
function checkClosedList(label: string, items: string[]): void {
  if (items.length === 0) throw new Error(`${label} is empty`);
  checkPossiblyEmptyList(label, items);
}

/**
 * The same shape check without the non-empty requirement, for the one list
 * whose emptiness is a real state: `unbound_rejections` names the registered
 * codes no op can yet produce, and format 2 emptied it by binding the last
 * one. Demanding a member would mean keeping a fake reservation alive to
 * satisfy a validator.
 */
function checkPossiblyEmptyList(label: string, items: string[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (item === '') throw new Error(`${label} contains an empty string`);
    if (seen.has(item)) throw new Error(`${label} repeats "${item}"`);
    seen.add(item);
  }
  const sorted = [...items].sort();
  // NUL as the join separator, so `["a b","c"]` and `["a","b c"]` cannot
  // compare equal. Written as the ESCAPE `\0`: this line held two RAW NUL
  // bytes from M24.1 until M26.3, which made git store the whole module as a
  // binary blob — no diff, no blame, no grep — exactly the failure
  // `.gitattributes` documents.
  if (sorted.join('\0') !== items.join('\0')) throw new Error(`${label} is not sorted`);
}

function checkMembers(label: string, items: string[], universe: Set<string>): void {
  checkClosedList(label, items);
  checkAllRegistered(label, items, universe);
}

function checkAllRegistered(label: string, items: string[], universe: Set<string>): void {
  for (const item of items) {
    if (!universe.has(item)) throw new Error(`${label} names unregistered value "${item}"`);
  }
}

/**
 * Parse and fully validate. Every refusal here has a counterpart in
 * `table.rs`; the refusal VECTORS in `table.test.ts` are what keep the two
 * honest about which artifacts they each reject.
 */
export function parseTable(value: unknown): PolicyTable {
  const table = value as PolicyTable;
  if (!SUPPORTED_FORMATS.includes(table.format)) {
    throw new Error(`${POLICY_PATH}: unsupported policy format ${table.format}`);
  }
  if (!(table.artifact_version > 0)) {
    throw new Error(`${POLICY_PATH}: artifact_version must be positive`);
  }
  checkClosedList('target_classes', table.target_classes);
  checkClosedList('predicates', table.predicates);
  checkClosedList('transitions', table.transitions);
  checkClosedList('rule_codes', table.rule_codes);
  // A RuleCode is a predicate, a transition, or one of these. The three
  // namespaces must not overlap, or "which rule refused this?" has two
  // answers.
  for (const extra of table.rule_codes) {
    if (table.predicates.includes(extra) || table.transitions.includes(extra)) {
      throw new Error(`rule_codes "${extra}" collides with a predicate or transition`);
    }
  }

  const classes = new Set(table.target_classes);
  const predicates = new Set(table.predicates);
  const transitions = new Set(table.transitions);
  const codes = new Set(Object.keys(table.rejection_destinies));
  const capabilities = new Set(Object.keys(table.capabilities));

  if (codes.size === 0) throw new Error('rejection_destinies is empty');
  checkMembers('transport_rejections', table.transport_rejections, codes);
  checkMembers('writer_rejections', table.writer_rejections, codes);
  const mint = table.mint_rejections ?? [];
  checkPossiblyEmptyList('mint_rejections', mint);
  checkAllRegistered('mint_rejections', mint, codes);
  checkPossiblyEmptyList('unbound_rejections', table.unbound_rejections);
  checkAllRegistered('unbound_rejections', table.unbound_rejections, codes);

  const stages = new Set<Stage>();
  for (const stage of table.evaluation_order) {
    if (stages.has(stage)) throw new Error(`evaluation_order repeats ${stage}`);
    stages.add(stage);
  }
  for (const stage of ALL_STAGES) {
    if (!stages.has(stage)) throw new Error(`evaluation_order omits ${stage}`);
  }

  if (table.escalators.length === 0) throw new Error('escalators is empty');
  const signals = new Set<string>();
  for (const escalator of table.escalators) {
    if (signals.has(escalator.signal)) {
      throw new Error(`escalators repeats signal "${escalator.signal}"`);
    }
    signals.add(escalator.signal);
    if (escalator.above !== undefined) {
      const threshold = table.thresholds[escalator.above];
      if (threshold === undefined) {
        throw new Error(`escalator "${escalator.signal}" names unknown threshold`);
      }
      if (!(threshold > 0)) throw new Error(`threshold "${escalator.above}" must be positive`);
    }
  }

  for (const risk of RISK_ORDER) {
    const rung = table.risk_ladder[risk];
    if (!rung) throw new Error(`risk_ladder has no rung for ${risk}`);
    if (rung.apply === 'auto' && rung.review !== undefined) {
      throw new Error(`risk_ladder ${risk} auto-applies but declares a review mode`);
    }
  }

  checkClosedList('silence.causes', table.silence.causes);
  checkMembers('silence.allowed_transitions', table.silence.allowed_transitions, transitions);
  const namedCodes: [string, string][] = [
    ['silence.rejection', table.silence.rejection],
    ['absence.incomplete_rejection', table.absence.incomplete_rejection],
    ['absence.mismatch_rejection', table.absence.mismatch_rejection],
    ['high_stakes.queue_rejection', table.high_stakes.queue_rejection],
    ['high_stakes.malformed_rejection', table.high_stakes.malformed_rejection],
    ['high_stakes.stale_rejection', table.high_stakes.stale_rejection],
    [
      'contradiction_addressing.omitted_rejection',
      table.contradiction_addressing.omitted_rejection,
    ],
    ['contradiction_addressing.stale_rejection', table.contradiction_addressing.stale_rejection],
  ];
  for (const [label, code] of namedCodes) {
    if (!codes.has(code)) throw new Error(`${label} names unregistered rejection "${code}"`);
  }
  checkClosedList(
    'absence.required_coverage_dimensions',
    table.absence.required_coverage_dimensions,
  );
  checkClosedList('absence.receipt_match_fields', table.absence.receipt_match_fields);
  if (table.high_stakes.stakes.length === 0) throw new Error('high_stakes.stakes is empty');

  if (!capabilities.has(table.contradiction_addressing.capability)) {
    throw new Error('contradiction_addressing names unknown capability');
  }
  const opNames = new Set(Object.keys(table.ops));
  checkMembers(
    'contradiction_addressing.required_for_ops',
    table.contradiction_addressing.required_for_ops,
    opNames,
  );

  for (const conditional of table.conditional_capabilities) {
    if (!opNames.has(conditional.op)) {
      throw new Error(`conditional_capabilities names unknown op "${conditional.op}"`);
    }
    if (!capabilities.has(conditional.capability)) {
      throw new Error(`conditional_capabilities names unknown capability`);
    }
    if (Object.keys(conditional.when).length === 0) {
      throw new Error(
        `conditional_capabilities for "${conditional.op}" has an empty condition — that is an ` +
          `unconditional gate wearing a conditional's clothes`,
      );
    }
  }

  if (opNames.size === 0) throw new Error('ops is empty');
  const specialCodes = new Set([
    ...table.transport_rejections,
    ...table.writer_rejections,
    ...mint,
    ...table.unbound_rejections,
  ]);
  for (const [name, op] of Object.entries(table.ops)) {
    checkMembers(`ops.${name}.target_classes`, op.target_classes, classes);
    checkMembers(`ops.${name}.allowed_transitions`, op.allowed_transitions, transitions);
    checkMembers(`ops.${name}.requires`, op.requires, predicates);
    checkMembers(`ops.${name}.possible_rejections`, op.possible_rejections, codes);
    if (op.requires_capability !== undefined && !capabilities.has(op.requires_capability)) {
      throw new Error(`ops.${name}.requires_capability names unknown capability`);
    }
    const possible = new Set(op.possible_rejections);
    for (const code of specialCodes) {
      if (possible.has(code)) {
        throw new Error(
          `ops.${name}.possible_rejections lists "${code}", which is a ` +
            `transport/writer/mint/unbound code the interpreter never returns per-op`,
        );
      }
    }
    if (op.requires_capability !== undefined && !possible.has('capability_unavailable')) {
      throw new Error(`ops.${name} is capability-gated but cannot report capability_unavailable`);
    }
    const selector = op.transition_selector;
    if (selector === undefined && op.allowed_transitions.length !== 1) {
      throw new Error(`ops.${name} allows several transitions with no transition_selector`);
    }
    if (selector !== undefined) {
      if (op.allowed_transitions.length === 1) {
        throw new Error(`ops.${name} has one transition and a selector to choose between them`);
      }
      if (selector.field === '')
        throw new Error(`ops.${name}.transition_selector has an empty field`);
      const mapped = new Set(Object.values(selector.map));
      for (const transition of op.allowed_transitions) {
        if (!mapped.has(transition)) {
          throw new Error(`ops.${name}.transition_selector never yields "${transition}"`);
        }
      }
      for (const transition of mapped) {
        if (!op.allowed_transitions.includes(transition)) {
          throw new Error(`ops.${name}.transition_selector yields unallowed "${transition}"`);
        }
      }
    }
  }

  // The format-2 preventive-ancestry binding. Absent is legal only for
  // format 1 — a format-2 table that omits it would claim the newer format
  // while carrying none of what the newer format is FOR.
  const ancestry = table.preventive_ancestry;
  if (ancestry === undefined) {
    if (table.format >= 2) {
      throw new Error(`${POLICY_PATH}: format ${table.format} declares no preventive_ancestry`);
    }
  } else {
    if (!predicates.has(ancestry.predicate)) {
      throw new Error(
        `preventive_ancestry.predicate names unregistered predicate "${ancestry.predicate}"`,
      );
    }
    if (!codes.has(ancestry.rejection)) {
      throw new Error(
        `preventive_ancestry.rejection names unregistered rejection "${ancestry.rejection}"`,
      );
    }
    checkMembers('preventive_ancestry.required_for_ops', ancestry.required_for_ops, opNames);
    // The binding is only a binding if the op rows agree, in both
    // directions: an op named here that does not require the predicate would
    // run no walk, and an op that requires it without being named would make
    // the block a partial map of where the gate runs.
    for (const name of ancestry.required_for_ops) {
      const rule = table.ops[name];
      if (!rule.requires.includes(ancestry.predicate)) {
        throw new Error(
          `preventive_ancestry requires "${name}" to run "${ancestry.predicate}", and its row does not`,
        );
      }
      if (!rule.possible_rejections.includes(ancestry.rejection)) {
        throw new Error(`ops.${name} runs the walk and cannot report "${ancestry.rejection}"`);
      }
    }
    for (const [name, rule] of Object.entries(table.ops)) {
      if (rule.requires.includes(ancestry.predicate) && !ancestry.required_for_ops.includes(name)) {
        throw new Error(
          `ops.${name} requires "${ancestry.predicate}" and preventive_ancestry does not list it`,
        );
      }
    }
  }

  // The format-2 in-session retry rule, on the same terms as the binding
  // above: absent is legal only for format 1.
  const retry = table.in_session_retry;
  if (retry === undefined) {
    if (table.format >= 2) {
      throw new Error(`${POLICY_PATH}: format ${table.format} declares no in_session_retry`);
    }
  } else {
    if (retry.max_attempts === 0) {
      throw new Error(
        'in_session_retry.max_attempts counts the first attempt, so 0 would forbid submitting at all',
      );
    }
    checkMembers('in_session_retry.retryable_rejections', retry.retryable_rejections, codes);
    // The one code that must never be here, named rather than left to
    // whoever edits the list next.
    if (retry.retryable_rejections.includes('human_rejected')) {
      throw new Error(
        'in_session_retry.retryable_rejections names human_rejected — a human decision is not a stale precondition',
      );
    }
  }

  const usedTransitions = new Set<string>();
  const usedPredicates = new Set<string>();
  for (const op of Object.values(table.ops)) {
    for (const t of op.allowed_transitions) usedTransitions.add(t);
    for (const p of op.requires) usedPredicates.add(p);
  }
  for (const transition of transitions) {
    if (!usedTransitions.has(transition)) {
      throw new Error(`transition "${transition}" is registered but no op allows it`);
    }
  }
  for (const predicate of predicates) {
    if (!usedPredicates.has(predicate)) {
      throw new Error(`predicate "${predicate}" is registered but no op requires it`);
    }
  }
  return table;
}

/** The shipped table, validated once at module load. */
export const POLICY: PolicyTable = parseTable(rawTable);

export function destiny(table: PolicyTable, code: string): Destiny | null {
  return table.rejection_destinies[code] ?? null;
}

export function op(table: PolicyTable, name: string): OpRule | null {
  return table.ops[name] ?? null;
}

export function threshold(table: PolicyTable, key: string): number | null {
  return table.thresholds[key] ?? null;
}

/** The capability blocking this op outright, or null. */
export function blockingCapability(table: PolicyTable, name: string): string | null {
  const rule = table.ops[name];
  const required = rule?.requires_capability;
  if (required === undefined) return null;
  const capability = table.capabilities[required];
  return capability !== undefined && !capability.available ? required : null;
}

/**
 * Which transition this op's payload selects. Single-transition ops answer
 * without consulting the payload; a multi-transition op reads the artifact's
 * selector field. `null` means the payload does not decide — a schema failure
 * upstream, never a default.
 */
export function transitionFor(
  table: PolicyTable,
  name: string,
  payloadConditions: Record<string, string>,
): string | null {
  const rule = table.ops[name];
  if (!rule) return null;
  const selector = rule.transition_selector;
  if (selector === undefined) return rule.allowed_transitions[0] ?? null;
  const value = payloadConditions[selector.field];
  if (value === undefined) return null;
  return selector.map[value] ?? null;
}
