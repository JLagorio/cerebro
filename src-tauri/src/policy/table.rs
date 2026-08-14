//! `shared/policy/policy.v3.json` — the declarative mutation-governance
//! table (M24.1, format 2 at M26.3, format 3 at M27.4).
//!
//! **The rule this module exists to enforce: policy is DATA.** Every risk
//! assignment, legal transition, required predicate, rejection destiny, and
//! capability gate lives in the shared JSON artifact that Rust and TS both
//! load. Nothing in this file names an op, a risk, or a rejection; it is
//! generic machinery over the table. A policy rule expressed as Rust `if`
//! (or as its TS twin) is a review-blocking defect — grow the table format
//! instead.
//!
//! Load is TOTAL and STRICT: an unknown predicate, transition, target
//! class, or rejection code, a code missing from the global destiny
//! registry, or an op whose declared sets are incomplete fails the load
//! before any interpreter runs. There is no "skip the row we did not
//! recognise" path, because a silently dropped rule reads as permission.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// The one artifact. `include_str!` binds it at compile time so a shipped
/// binary can never disagree with the tree it was built from.
pub const POLICY_JSON: &str = include_str!("../../../shared/policy/policy.v3.json");

/// Repo-relative location, for the test that proves both languages read the
/// same path.
pub const POLICY_PATH: &str = "shared/policy/policy.v3.json";

/// The committed SHA-256 of the table's bytes. Rust and TS each hash what
/// they actually loaded and compare against THIS file — which is the only
/// way two processes in two languages assert the same bytes rather than
/// each asserting self-consistency. Regenerate deliberately after a table
/// edit (see `write_policy_digest`).
pub const POLICY_DIGEST_PATH: &str = "shared/policy/policy.v3.sha256";

/// The FROZEN format-1 artifact (M24). It is kept compiled in for one
/// reason: it is the negative control that proves the M26.3 live-registration
/// gate refuses for the RIGHT reason. A v1 table is a perfectly valid table
/// that simply does not bind `no_self_ancestry`, so registering the proposal
/// tools against it must fail on the absent binding rather than on an
/// unknown code — and a hand-written stub could not prove that, because a
/// stub is written by whoever wants the test to pass.
///
/// Nothing edits these bytes. Policy changes land in `POLICY_JSON`.
pub const POLICY_V1_JSON: &str = include_str!("../../../shared/policy/policy.v1.json");
pub const POLICY_V1_PATH: &str = "shared/policy/policy.v1.json";
pub const POLICY_V1_DIGEST_PATH: &str = "shared/policy/policy.v1.sha256";

/// The FROZEN format-2 artifact (M26.3), kept for the same reason v1 is, and
/// pointed at a different gate.
///
/// v2 is a valid table that simply has `contradiction_edges` UNAVAILABLE —
/// which is what the whole of M24 through M26 shipped, and what "the gate is
/// not live yet" looked like in data. M27.4's activation must refuse against
/// it by naming the unavailable capability, not by tripping over an unknown
/// code, and only the real bytes can prove that.
///
/// Nothing edits these bytes either. Policy changes land in `POLICY_JSON`.
pub const POLICY_V2_JSON: &str = include_str!("../../../shared/policy/policy.v2.json");
pub const POLICY_V2_PATH: &str = "shared/policy/policy.v2.json";
pub const POLICY_V2_DIGEST_PATH: &str = "shared/policy/policy.v2.sha256";

/// The format this build SHIPS.
pub const FORMAT: u64 = 3;

/// Every format this build can READ. A published artifact is history: format
/// 1 was the whole of M24 and M25, format 2 the whole of M26, and refusing to
/// parse either would mean the only way to demonstrate what the next format
/// added is a fixture nobody committed.
pub const SUPPORTED_FORMATS: &[u64] = &[1, 2, 3];

/// Risk is a PERSISTED vocabulary — a Proposal declares one and
/// `proposal.applied` records the effective one — so it is defined once in
/// the ledger schema and re-exported here. A second copy in the policy
/// layer could drift from the bytes already on disk.
pub use crate::ledger::schema::Risk;

/// Where a refused proposal is RECORDED — the D5 two-records split. Never
/// inferred: every code names its destiny in the table's one registry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Destiny {
    /// Epistemic history: the ledger, where the Skeptic can read it.
    Ledger,
    /// Server-log noise: the runtime DB, so the ledger never becomes
    /// "Claude forgot a required field 92,000 times".
    Operational,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApplyMode {
    Auto,
    QueuedHumanCard,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LadderRung {
    pub apply: ApplyMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub journal: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Revert {
    OneClick,
    None,
}

/// A deterministic escalator. `above` names a `thresholds` key rather than
/// carrying a literal, so the number is tunable as data in one place.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Escalator {
    pub signal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub above: Option<String>,
    pub floor: Risk,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capability {
    pub available: bool,
    /// The milestone that turns it on — documentation, not logic.
    pub arrives: String,
}

/// A capability gate that depends on the payload rather than the op alone
/// (`edit_relation(add, contradicts)` needs M27's comparison expansion; a
/// plain relation add does not).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConditionalCapability {
    pub op: String,
    pub when: BTreeMap<String, String>,
    pub capability: String,
}

/// Silence never resolves (§10). Expressed as an ALLOWLIST so a transition
/// added later is forbidden under silence by default — the safe direction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SilenceRule {
    pub causes: Vec<String>,
    pub allowed_transitions: Vec<String>,
    pub rejection: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AbsenceRule {
    pub required_coverage_dimensions: Vec<String>,
    pub receipt_match_fields: Vec<String>,
    pub incomplete_rejection: String,
    pub mismatch_rejection: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HighStakesRule {
    pub stakes: Vec<Risk>,
    pub queue_rejection: String,
    pub malformed_rejection: String,
    pub stale_rejection: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContradictionAddressingRule {
    pub required_for_ops: Vec<String>,
    pub capability: String,
    pub omitted_rejection: String,
    pub stale_rejection: String,
}

/// The format-2 binding for the preventive anti-self-ancestry walk (M26.3).
///
/// **Which ops must prove it is DATA.** The walk itself is code — it reads a
/// proposal's basis and a reducer index — but "an op that changes what a
/// Belief rests on must run it" is a policy statement, and a policy statement
/// hand-listed inside the registration gate is the second inventory this
/// milestone's parity rules forbid. Load proves the block, the ops'
/// `requires`, and the ops' `possible_rejections` all agree, so "is the gate
/// bound?" is one question with one answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreventiveAncestryRule {
    pub required_for_ops: Vec<String>,
    pub predicate: String,
    pub rejection: String,
}

/// When an agent may resubmit a refused proposal inside the run it is already
/// paying for (M26.4e).
///
/// **Retryability is policy, not plumbing.** "May the agent try this again?"
/// has one answer, and an answer hand-listed in Rust and again in TS is the
/// twin implementation the artifact exists to prevent. So the list is data,
/// and the loader proves every entry is a code that exists.
///
/// The line the list draws: retryable refusals are about the STATE OF THE
/// REQUEST — the world moved under it, a receipt went stale, the message was
/// malformed. Refusals about the SUBSTANCE of the change are not retryable at
/// any count, because retrying those is not adjustment, it is wearing the
/// gate down. Growing this list needs that argument made in review.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InSessionRetryRule {
    /// Attempts per proposal INCLUDING the first. 1 would mean no retry.
    pub max_attempts: u32,
    pub retryable_rejections: Vec<String>,
}

/// What a run may do after a typed rejection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryVerdict {
    /// Adjust and resubmit inside this run.
    Retry,
    /// Retryable in principle, and this proposal has had its attempts.
    Exhausted,
    /// The refusal is about the substance of the change. Resubmitting it is
    /// not adjustment.
    NotRetryable,
}

/// The table-decidable evaluation stages, in the order the artifact fixes.
/// Precedence between refusals IS policy — "does an unavailable capability
/// outrank an understated risk?" has an answer, and that answer belongs in
/// the artifact both engines read, not in whichever `if` happens to come
/// first in each language.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    /// Is the op (or this payload shape) switched on in this build at all?
    Capability,
    /// Does every named target belong to a class this op may touch?
    TargetClass,
    /// Did the proposal declare a risk below the table's base?
    RiskDeclaration,
    /// Is this transition reachable from a silence-class transition cause?
    Silence,
}

impl Stage {
    pub const ALL: [Stage; 4] = [
        Stage::Capability,
        Stage::TargetClass,
        Stage::RiskDeclaration,
        Stage::Silence,
    ];
}

/// How a multi-transition op picks its transition from its payload. Which
/// payload field decides, and what each value means, is the artifact's
/// business — the alternative is an `if kind == "edit_relation"` ladder in
/// two languages, which is exactly the defect this milestone forbids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TransitionSelector {
    pub field: String,
    pub map: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpRule {
    pub target_classes: Vec<String>,
    pub base_risk: Risk,
    pub revert: Revert,
    pub allowed_transitions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_selector: Option<TransitionSelector>,
    pub requires: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requires_capability: Option<String>,
    pub possible_rejections: Vec<String>,
    /// May an AGENT propose this op through the live MCP surface (M26.3c)?
    ///
    /// Defaults to true, so the artifact says only where the answer is NO and
    /// a new op is agent-facing unless somebody argues otherwise. That is the
    /// right default for a table whose whole job is to govern agent
    /// mutations: an op quietly excluded by omission would be a capability
    /// nobody could find the reasoning for.
    ///
    /// Two are FALSE today, both found by attacking the surface rather than
    /// by reading it:
    ///
    /// - **`revert_proposal`** is MEDIUM, and MEDIUM auto-applies — so an
    ///   agent-facing revert would let a model silently undo an applied
    ///   mutation, including one a human had just approved on a HIGH card,
    ///   with no second card to notice. Revert is the human's undo; the
    ///   server authors it from the review surface.
    /// - **`append_observation`** carries the SERVER-CANONICAL
    ///   `ObservationRecorded` body in its payload, and `expand.rs`'s arm for
    ///   it is the only one of the twenty that does not stamp the run's
    ///   actor — it passes the caller's `actor` through verbatim. Since
    ///   `reduce.rs` derives AUTHORITY from that actor, an agent could mint
    ///   an observation attributed to the human and carrying
    ///   `TrustedHumanCapture`. The predicate meant to stop this,
    ///   `trusted_observation_provenance`, is required by the row and
    ///   evaluated NOWHERE: its declared owner is `AgentObservationDraft`,
    ///   the impoverished wire DTO that cannot spell `human_assertion`, and
    ///   nothing converts a draft into a recorded observation. The op is not
    ///   ready for an agent until that conversion exists, so it is withheld
    ///   here rather than served past a door that does not close.
    #[serde(default = "agent_facing_default")]
    pub agent_facing: bool,
}

fn agent_facing_default() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyTable {
    pub format: u64,
    pub artifact_version: u64,
    pub target_classes: Vec<String>,
    pub predicates: Vec<String>,
    pub transitions: Vec<String>,
    pub rejection_destinies: BTreeMap<String, Destiny>,
    /// The `RuleCode` members that are NOT predicates or transitions —
    /// `risk_ladder`, `target_version`, and friends. Registered here so
    /// `RuleCode` is validated against the artifact rather than against a
    /// Rust enum that would have to be kept in step with it by hand.
    pub rule_codes: Vec<String>,
    pub transport_rejections: Vec<String>,
    pub writer_rejections: Vec<String>,
    /// Codes the server returns while MINTING a search receipt — before any
    /// proposal exists (M26.2). A fourth category beside transport and
    /// writer because it fails at a fourth place: not the wire, not the
    /// ledger, and not an op's policy evaluation. Absent in format 1.
    #[serde(default)]
    pub mint_rejections: Vec<String>,
    pub unbound_rejections: Vec<String>,
    pub evaluation_order: Vec<Stage>,
    pub thresholds: BTreeMap<String, u64>,
    pub escalators: Vec<Escalator>,
    pub capabilities: BTreeMap<String, Capability>,
    pub conditional_capabilities: Vec<ConditionalCapability>,
    pub silence: SilenceRule,
    pub absence: AbsenceRule,
    pub high_stakes: HighStakesRule,
    pub contradiction_addressing: ContradictionAddressingRule,
    /// Absent in format 1, required from format 2. `Option` rather than a
    /// `default` value: "this table predates the gate" and "this table binds
    /// the gate to nothing" must not be the same reading.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preventive_ancestry: Option<PreventiveAncestryRule>,
    #[serde(default)]
    pub in_session_retry: Option<InSessionRetryRule>,
    pub risk_ladder: BTreeMap<Risk, LadderRung>,
    pub ops: BTreeMap<String, OpRule>,
}

/// Sorted, unique, non-empty — the shape every closed list in the artifact
/// must have, so two tables that mean the same thing cannot differ.
fn check_closed_list(label: &str, items: &[String]) -> Result<(), String> {
    if items.is_empty() {
        return Err(format!("{label} is empty"));
    }
    check_possibly_empty_list(label, items)
}

/// The same shape check without the non-empty requirement, for the one list
/// whose emptiness is a real and desirable state: `unbound_rejections` names
/// the codes registered in the destiny registry that no op can yet produce,
/// and format 2 emptied it by binding the last one. Demanding a member would
/// mean keeping a fake reservation alive to satisfy a validator.
fn check_possibly_empty_list(label: &str, items: &[String]) -> Result<(), String> {
    let mut seen = BTreeSet::new();
    for item in items {
        if item.is_empty() {
            return Err(format!("{label} contains an empty string"));
        }
        if !seen.insert(item.as_str()) {
            return Err(format!("{label} repeats {item:?}"));
        }
    }
    let mut sorted = items.to_vec();
    sorted.sort();
    if sorted != items {
        return Err(format!("{label} is not sorted"));
    }
    Ok(())
}

fn check_members(label: &str, items: &[String], universe: &BTreeSet<&str>) -> Result<(), String> {
    check_closed_list(label, items)?;
    check_all_registered(label, items, universe)
}

fn check_all_registered(
    label: &str,
    items: &[String],
    universe: &BTreeSet<&str>,
) -> Result<(), String> {
    for item in items {
        if !universe.contains(item.as_str()) {
            return Err(format!("{label} names unregistered value {item:?}"));
        }
    }
    Ok(())
}

impl PolicyTable {
    /// Parse and fully validate the compiled-in artifact.
    pub fn load() -> Result<PolicyTable, String> {
        Self::parse(POLICY_JSON)
    }

    pub fn parse(raw: &str) -> Result<PolicyTable, String> {
        let table: PolicyTable =
            serde_json::from_str(raw).map_err(|e| format!("{POLICY_PATH}: {e}"))?;
        table.validate()?;
        Ok(table)
    }

    fn validate(&self) -> Result<(), String> {
        if !SUPPORTED_FORMATS.contains(&self.format) {
            return Err(format!(
                "{POLICY_PATH}: unsupported policy format {}",
                self.format
            ));
        }
        if self.artifact_version == 0 {
            return Err(format!("{POLICY_PATH}: artifact_version must be positive"));
        }
        check_closed_list("target_classes", &self.target_classes)?;
        check_closed_list("predicates", &self.predicates)?;
        check_closed_list("transitions", &self.transitions)?;
        check_closed_list("rule_codes", &self.rule_codes)?;
        // A `RuleCode` is a predicate, a transition, or one of these. The
        // three namespaces must not overlap, or "which rule refused this?"
        // has two answers.
        for extra in &self.rule_codes {
            if self.predicates.contains(extra) || self.transitions.contains(extra) {
                return Err(format!(
                    "rule_codes {extra:?} collides with a predicate or transition of the same name"
                ));
            }
        }

        let classes: BTreeSet<&str> = self.target_classes.iter().map(String::as_str).collect();
        let predicates: BTreeSet<&str> = self.predicates.iter().map(String::as_str).collect();
        let transitions: BTreeSet<&str> = self.transitions.iter().map(String::as_str).collect();
        let codes: BTreeSet<&str> = self
            .rejection_destinies
            .keys()
            .map(String::as_str)
            .collect();
        let capabilities: BTreeSet<&str> = self.capabilities.keys().map(String::as_str).collect();

        if self.rejection_destinies.is_empty() {
            return Err("rejection_destinies is empty".to_string());
        }
        // The three special registries partition nothing, but each entry
        // must be a registered code — an unknown one here would be a
        // rejection nobody can ever route.
        check_members("transport_rejections", &self.transport_rejections, &codes)?;
        check_members("writer_rejections", &self.writer_rejections, &codes)?;
        check_possibly_empty_list("mint_rejections", &self.mint_rejections)?;
        check_all_registered("mint_rejections", &self.mint_rejections, &codes)?;
        check_possibly_empty_list("unbound_rejections", &self.unbound_rejections)?;
        check_all_registered("unbound_rejections", &self.unbound_rejections, &codes)?;

        // Every stage runs exactly once. A missing stage would silently
        // disable a whole class of refusal; a repeated one would make
        // "which refusal wins" depend on where it repeats.
        {
            let mut seen = BTreeSet::new();
            for stage in &self.evaluation_order {
                if !seen.insert(*stage) {
                    return Err(format!("evaluation_order repeats {stage:?}"));
                }
            }
            for stage in Stage::ALL {
                if !seen.contains(&stage) {
                    return Err(format!("evaluation_order omits {stage:?}"));
                }
            }
        }

        // Escalators: a threshold-shaped signal must name a real threshold,
        // and a floor-only signal must not name one.
        if self.escalators.is_empty() {
            return Err("escalators is empty".to_string());
        }
        let mut escalator_signals = BTreeSet::new();
        for escalator in &self.escalators {
            if !escalator_signals.insert(escalator.signal.as_str()) {
                return Err(format!("escalators repeats signal {:?}", escalator.signal));
            }
            if let Some(key) = &escalator.above {
                let value = self.thresholds.get(key).ok_or_else(|| {
                    format!(
                        "escalator {:?} names unknown threshold {key:?}",
                        escalator.signal
                    )
                })?;
                if *value == 0 {
                    return Err(format!("threshold {key:?} must be positive"));
                }
            }
        }

        // The risk ladder must rate every risk exactly once, and a
        // queued rung is the only place a review mode belongs.
        for risk in [Risk::Low, Risk::Medium, Risk::High, Risk::Critical] {
            let rung = self
                .risk_ladder
                .get(&risk)
                .ok_or_else(|| format!("risk_ladder has no rung for {}", risk.as_str()))?;
            if rung.apply == ApplyMode::Auto && rung.review.is_some() {
                return Err(format!(
                    "risk_ladder {} auto-applies but declares a review mode",
                    risk.as_str()
                ));
            }
        }

        // `causes` names Proposal `basis.transition_cause` values, whose
        // closed union is owned by the proposal schema (M24.3) — the table
        // holds the shape, not a second copy of that enum.
        check_closed_list("silence.causes", &self.silence.causes)?;
        check_members(
            "silence.allowed_transitions",
            &self.silence.allowed_transitions,
            &transitions,
        )?;
        for (label, code) in [
            ("silence.rejection", &self.silence.rejection),
            (
                "absence.incomplete_rejection",
                &self.absence.incomplete_rejection,
            ),
            (
                "absence.mismatch_rejection",
                &self.absence.mismatch_rejection,
            ),
            (
                "high_stakes.queue_rejection",
                &self.high_stakes.queue_rejection,
            ),
            (
                "high_stakes.malformed_rejection",
                &self.high_stakes.malformed_rejection,
            ),
            (
                "high_stakes.stale_rejection",
                &self.high_stakes.stale_rejection,
            ),
            (
                "contradiction_addressing.omitted_rejection",
                &self.contradiction_addressing.omitted_rejection,
            ),
            (
                "contradiction_addressing.stale_rejection",
                &self.contradiction_addressing.stale_rejection,
            ),
        ] {
            if !codes.contains(code.as_str()) {
                return Err(format!("{label} names unregistered rejection {code:?}"));
            }
        }
        check_closed_list(
            "absence.required_coverage_dimensions",
            &self.absence.required_coverage_dimensions,
        )?;
        check_closed_list(
            "absence.receipt_match_fields",
            &self.absence.receipt_match_fields,
        )?;
        if self.high_stakes.stakes.is_empty() {
            return Err("high_stakes.stakes is empty".to_string());
        }

        if !capabilities.contains(self.contradiction_addressing.capability.as_str()) {
            return Err(format!(
                "contradiction_addressing names unknown capability {:?}",
                self.contradiction_addressing.capability
            ));
        }
        let op_names: BTreeSet<&str> = self.ops.keys().map(String::as_str).collect();
        check_members(
            "contradiction_addressing.required_for_ops",
            &self.contradiction_addressing.required_for_ops,
            &op_names,
        )?;

        for conditional in &self.conditional_capabilities {
            if !self.ops.contains_key(&conditional.op) {
                return Err(format!(
                    "conditional_capabilities names unknown op {:?}",
                    conditional.op
                ));
            }
            if !capabilities.contains(conditional.capability.as_str()) {
                return Err(format!(
                    "conditional_capabilities names unknown capability {:?}",
                    conditional.capability
                ));
            }
            if conditional.when.is_empty() {
                return Err(format!(
                    "conditional_capabilities for {:?} has an empty condition — that is an \
                     unconditional gate wearing a conditional's clothes",
                    conditional.op
                ));
            }
        }

        if self.ops.is_empty() {
            return Err("ops is empty".to_string());
        }
        for (name, op) in &self.ops {
            check_members(
                &format!("ops.{name}.target_classes"),
                &op.target_classes,
                &classes,
            )?;
            check_members(
                &format!("ops.{name}.allowed_transitions"),
                &op.allowed_transitions,
                &transitions,
            )?;
            check_members(&format!("ops.{name}.requires"), &op.requires, &predicates)?;
            check_members(
                &format!("ops.{name}.possible_rejections"),
                &op.possible_rejections,
                &codes,
            )?;
            if let Some(capability) = &op.requires_capability {
                if !capabilities.contains(capability.as_str()) {
                    return Err(format!(
                        "ops.{name}.requires_capability names unknown capability {capability:?}"
                    ));
                }
            }
            // A rejection an op can never produce is dead policy; a
            // rejection it CAN produce but does not list is invisible
            // policy. Both are load failures, so the per-op set stays the
            // honest description the interpreter is checked against.
            let possible: BTreeSet<&str> =
                op.possible_rejections.iter().map(String::as_str).collect();
            for code in self
                .transport_rejections
                .iter()
                .chain(self.writer_rejections.iter())
                .chain(self.mint_rejections.iter())
                .chain(self.unbound_rejections.iter())
            {
                if possible.contains(code.as_str()) {
                    return Err(format!(
                        "ops.{name}.possible_rejections lists {code:?}, which is a \
                         transport/writer/mint/unbound code the interpreter never returns per-op"
                    ));
                }
            }
            if op.requires_capability.is_some() && !possible.contains("capability_unavailable") {
                return Err(format!(
                    "ops.{name} is capability-gated but cannot report capability_unavailable"
                ));
            }
            // A single-transition op needs no selector; a multi-transition
            // op without one has an undecidable transition, and a selector
            // that does not cover every allowed transition leaves one
            // unreachable.
            match (&op.transition_selector, op.allowed_transitions.len()) {
                (None, 1) => {}
                (None, _) => {
                    return Err(format!(
                        "ops.{name} allows several transitions with no transition_selector"
                    ))
                }
                (Some(_), 1) => {
                    return Err(format!(
                        "ops.{name} has one transition and a selector to choose between them"
                    ))
                }
                (Some(selector), _) => {
                    if selector.field.is_empty() {
                        return Err(format!("ops.{name}.transition_selector has an empty field"));
                    }
                    let mapped: BTreeSet<&str> =
                        selector.map.values().map(String::as_str).collect();
                    for transition in &op.allowed_transitions {
                        if !mapped.contains(transition.as_str()) {
                            return Err(format!(
                                "ops.{name}.transition_selector never yields {transition:?}"
                            ));
                        }
                    }
                    for transition in &mapped {
                        if !op.allowed_transitions.iter().any(|t| t == transition) {
                            return Err(format!(
                                "ops.{name}.transition_selector yields unallowed {transition:?}"
                            ));
                        }
                    }
                }
            }
        }

        // The format-2 preventive-ancestry binding. Absent is legal only for
        // format 1 — a format-2 table that omits it would claim the newer
        // format while carrying none of what the newer format is FOR.
        match &self.preventive_ancestry {
            None if self.format >= 2 => {
                return Err(format!(
                    "{POLICY_PATH}: format {} declares no preventive_ancestry binding",
                    self.format
                ))
            }
            None => {}
            Some(rule) => {
                if !predicates.contains(rule.predicate.as_str()) {
                    return Err(format!(
                        "preventive_ancestry.predicate names unregistered predicate {:?}",
                        rule.predicate
                    ));
                }
                if !codes.contains(rule.rejection.as_str()) {
                    return Err(format!(
                        "preventive_ancestry.rejection names unregistered rejection {:?}",
                        rule.rejection
                    ));
                }
                check_members(
                    "preventive_ancestry.required_for_ops",
                    &rule.required_for_ops,
                    &op_names,
                )?;
                // The binding is only a binding if the op rows agree. An op
                // named here that does not REQUIRE the predicate would run
                // no walk, and one that cannot report the rejection would
                // have to refuse under a code it never declared.
                for name in &rule.required_for_ops {
                    let op = &self.ops[name];
                    if !op.requires.contains(&rule.predicate) {
                        return Err(format!(
                            "preventive_ancestry requires {name:?} to run {:?}, and its row does not",
                            rule.predicate
                        ));
                    }
                    if !op.possible_rejections.contains(&rule.rejection) {
                        return Err(format!(
                            "ops.{name} runs {:?} and cannot report {:?}",
                            rule.predicate, rule.rejection
                        ));
                    }
                }
                // And nothing outside the list may require it, or the block
                // would be a partial description of where the gate runs.
                for (name, op) in &self.ops {
                    if op.requires.contains(&rule.predicate)
                        && !rule.required_for_ops.contains(name)
                    {
                        return Err(format!(
                            "ops.{name} requires {:?} and preventive_ancestry does not list it",
                            rule.predicate
                        ));
                    }
                }
            }
        }

        // The format-2 in-session retry rule, on the same terms as the
        // ancestry binding: absent is legal only for format 1.
        match &self.in_session_retry {
            None if self.format >= 2 => {
                return Err(format!(
                    "{POLICY_PATH}: format {} declares no in_session_retry rule",
                    self.format
                ))
            }
            None => {}
            Some(rule) => {
                if rule.max_attempts == 0 {
                    return Err(
                        "in_session_retry.max_attempts counts the first attempt, so 0 \
                                would forbid submitting at all"
                            .into(),
                    );
                }
                check_members(
                    "in_session_retry.retryable_rejections",
                    &rule.retryable_rejections,
                    &codes,
                )?;
                // The one code that must never be here, named rather than
                // left to whoever edits the list next. A human said no; a
                // retry is not an adjustment, it is asking again.
                if rule
                    .retryable_rejections
                    .iter()
                    .any(|c| c == "human_rejected")
                {
                    return Err(
                        "in_session_retry.retryable_rejections names human_rejected — a human \
                         decision is not a stale precondition"
                            .into(),
                    );
                }
            }
        }

        // Every registered transition must belong to some op, or it is a
        // name with no meaning; every predicate likewise.
        let mut used_transitions = BTreeSet::new();
        let mut used_predicates = BTreeSet::new();
        for op in self.ops.values() {
            used_transitions.extend(op.allowed_transitions.iter().map(String::as_str));
            used_predicates.extend(op.requires.iter().map(String::as_str));
        }
        for transition in &transitions {
            if !used_transitions.contains(transition) {
                return Err(format!(
                    "transition {transition:?} is registered but no op allows it"
                ));
            }
        }
        for predicate in &predicates {
            if !used_predicates.contains(predicate) {
                return Err(format!(
                    "predicate {predicate:?} is registered but no op requires it"
                ));
            }
        }
        Ok(())
    }

    pub fn destiny(&self, code: &str) -> Option<Destiny> {
        self.rejection_destinies.get(code).copied()
    }

    /// The ops an agent may propose through the live MCP surface, sorted.
    ///
    /// THE registration inventory (M26.3c). Derived from the artifact every
    /// time rather than cached or copied: a second list of agent-facing op
    /// names is the hand-maintained inventory the milestone's parity rules
    /// forbid, and it is exactly the list that would rot silently.
    pub fn agent_facing_ops(&self) -> Vec<&str> {
        self.ops
            .iter()
            .filter(|(_, rule)| rule.agent_facing)
            .map(|(name, _)| name.as_str())
            .collect()
    }

    pub fn op(&self, name: &str) -> Option<&OpRule> {
        self.ops.get(name)
    }

    /// May a run resubmit after this refusal, having already made
    /// `attempts_so_far` attempts on this proposal?
    ///
    /// Three answers rather than a bool, because "the table says no" and "you
    /// have used your attempts" are different sentences and the window's
    /// explanation should say which one happened.
    pub fn retry_verdict(&self, code: &str, attempts_so_far: u32) -> RetryVerdict {
        let Some(rule) = &self.in_session_retry else {
            // A table with no rule grants no retries. The safe direction: a
            // format-1 table predates the concept and must not be read as
            // permission.
            return RetryVerdict::NotRetryable;
        };
        if !rule.retryable_rejections.iter().any(|c| c == code) {
            return RetryVerdict::NotRetryable;
        }
        if attempts_so_far >= rule.max_attempts {
            return RetryVerdict::Exhausted;
        }
        RetryVerdict::Retry
    }

    pub fn threshold(&self, key: &str) -> Option<u64> {
        self.thresholds.get(key).copied()
    }

    /// Which transition this op's payload selects. Single-transition ops
    /// answer without consulting the payload at all; a multi-transition op
    /// reads the artifact's selector field. `None` means the payload does
    /// not decide — a schema failure upstream, never a default.
    pub fn transition_for(
        &self,
        op: &str,
        payload_conditions: &BTreeMap<String, String>,
    ) -> Option<String> {
        let rule = self.ops.get(op)?;
        match &rule.transition_selector {
            None => rule.allowed_transitions.first().cloned(),
            Some(selector) => {
                let value = payload_conditions.get(&selector.field)?;
                selector.map.get(value).cloned()
            }
        }
    }

    /// One of the FROZEN tables, by the name a golden fixture may pin.
    ///
    /// The frozen artifacts are already this repo's negative controls — v1
    /// predates `no_self_ancestry`, v2 predates `contradiction_edges`. This
    /// lets a shared fixture replay against one, which is what keeps a refusal
    /// the shipped table can no longer produce from losing its parity
    /// coverage entirely.
    pub fn frozen(name: &str) -> Result<PolicyTable, String> {
        match name {
            "v1" => Self::parse(POLICY_V1_JSON),
            "v2" => Self::parse(POLICY_V2_JSON),
            other => Err(format!(
                "{other:?} is not a frozen policy table — the committed ones are v1 and v2"
            )),
        }
    }

    /// Is this op available given the table's capability flags? Returns the
    /// blocking capability name, or `None` when it is clear.
    pub fn blocking_capability(&self, name: &str) -> Option<&str> {
        let op = self.ops.get(name)?;
        let capability = op.requires_capability.as_deref()?;
        match self.capabilities.get(capability) {
            Some(c) if !c.available => Some(capability),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shipped_table_loads_and_validates() {
        let table = PolicyTable::load().expect("the committed policy table must load");
        assert_eq!(table.format, FORMAT);
        assert!(!table.ops.is_empty());
    }

    fn repo(rel: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(rel)
    }

    #[test]
    fn the_loaded_bytes_match_the_committed_digest() {
        // The cross-language anchor. `table.test.ts` hashes the bytes it
        // loaded and compares against the same file, so if the two languages
        // ever read different artifacts they disagree with this digest
        // rather than quietly diverging.
        let committed = std::fs::read_to_string(repo(POLICY_DIGEST_PATH))
            .expect("read the committed policy digest")
            .trim()
            .to_string();
        assert_eq!(
            crate::ledger::sha256_hex(POLICY_JSON.as_bytes()),
            committed,
            "the table changed without regenerating {POLICY_DIGEST_PATH} — run \
             `cargo test --lib policy::table::tests::write_policy_digest -- --ignored`"
        );
    }

    /// Re-stamp the digest after a deliberate table edit.
    #[test]
    #[ignore = "run explicitly after a deliberate policy-table edit"]
    fn write_policy_digest() {
        let digest = crate::ledger::sha256_hex(POLICY_JSON.as_bytes());
        std::fs::write(repo(POLICY_DIGEST_PATH), format!("{digest}\n")).unwrap();
        println!("{POLICY_PATH} digest = {digest}");
    }

    #[test]
    fn the_compiled_table_is_the_file_on_disk() {
        // `include_str!` binds at compile time; a stale build that disagreed
        // with the tree would make every other policy test meaningless.
        let disk = std::fs::read_to_string(repo(POLICY_PATH)).expect("read the shared table");
        assert_eq!(disk, POLICY_JSON);
    }

    #[test]
    fn the_frozen_v1_artifact_still_hashes_to_what_m24_published() {
        // v1 is HISTORY, and it is also the negative control the M26.3
        // registration gate is tested against. A "small fix" to it would
        // quietly change what that control proves, so its bytes are pinned
        // exactly like the live table's — with no regeneration test, because
        // there is no legitimate edit.
        let disk = std::fs::read_to_string(repo(POLICY_V1_PATH)).expect("read the frozen table");
        assert_eq!(disk, POLICY_V1_JSON);
        let committed = std::fs::read_to_string(repo(POLICY_V1_DIGEST_PATH))
            .expect("read the frozen digest")
            .trim()
            .to_string();
        assert_eq!(
            crate::ledger::sha256_hex(POLICY_V1_JSON.as_bytes()),
            committed
        );
    }

    #[test]
    fn the_frozen_v1_artifact_still_loads() {
        // Not nostalgia: the gate's negative control must be a table that
        // PARSES and simply lacks the binding. If v1 stopped loading, the
        // "registration against v1 refuses for the right reason" test would
        // start passing for the wrong one.
        let v1 = PolicyTable::parse(POLICY_V1_JSON).expect("the frozen v1 table must still load");
        assert_eq!(v1.format, 1);
        assert_eq!(v1.preventive_ancestry, None);
        assert_eq!(v1.in_session_retry, None);
    }

    fn mutated(f: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut raw: serde_json::Value = serde_json::from_str(POLICY_JSON).unwrap();
        f(&mut raw);
        raw.to_string()
    }

    #[test]
    fn an_unknown_predicate_fails_the_load() {
        let raw = mutated(|v| {
            v["ops"]["promote_draft"]["requires"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!("zzz_invented_predicate"));
        });
        let err = PolicyTable::parse(&raw).unwrap_err();
        assert!(err.contains("zzz_invented_predicate"), "{err}");
    }

    #[test]
    fn an_unknown_transition_fails_the_load() {
        let raw = mutated(|v| {
            v["ops"]["promote_draft"]["allowed_transitions"] = serde_json::json!(["teleport"]);
        });
        assert!(PolicyTable::parse(&raw).unwrap_err().contains("teleport"));
    }

    #[test]
    fn an_unknown_target_class_fails_the_load() {
        let raw = mutated(|v| {
            v["ops"]["promote_draft"]["target_classes"] = serde_json::json!(["belief", "vibe"]);
        });
        assert!(PolicyTable::parse(&raw).unwrap_err().contains("vibe"));
    }

    #[test]
    fn a_rejection_code_missing_from_the_registry_fails_the_load() {
        let raw = mutated(|v| {
            let list = v["ops"]["promote_draft"]["possible_rejections"]
                .as_array_mut()
                .unwrap();
            list.push(serde_json::json!("just_because"));
            // Keep it sorted so the MEMBERSHIP check is what fires, not the
            // ordering check standing in front of it.
            list.sort_by_key(|c| c.as_str().unwrap().to_string());
        });
        assert!(PolicyTable::parse(&raw)
            .unwrap_err()
            .contains("just_because"));
    }

    #[test]
    fn an_unregistered_field_fails_the_load_rather_than_being_dropped() {
        // A silently ignored key is a rule somebody wrote and nobody runs.
        let raw = mutated(|v| {
            v["ops"]["promote_draft"]["max_auto_apply"] = serde_json::json!("CRITICAL");
        });
        assert!(PolicyTable::parse(&raw).is_err());
    }

    #[test]
    fn an_escalator_pointing_at_no_threshold_fails_the_load() {
        let raw = mutated(|v| {
            v["escalators"][1]["above"] = serde_json::json!("lineage_fan_in_enormous");
        });
        assert!(PolicyTable::parse(&raw)
            .unwrap_err()
            .contains("lineage_fan_in_enormous"));
    }

    #[test]
    fn an_unsorted_closed_list_fails_the_load() {
        // Sorting is not cosmetics: two tables that mean the same thing must
        // not be able to differ, or the byte-identity check is theatre.
        let raw = mutated(|v| {
            v["target_classes"] = serde_json::json!([
                "belief",
                "observation",
                "entity",
                "relation",
                "source",
                "proposal",
                "comparison"
            ]);
        });
        assert!(PolicyTable::parse(&raw).unwrap_err().contains("not sorted"));
    }

    #[test]
    fn a_capability_gated_op_must_be_able_to_say_so() {
        let raw = mutated(|v| {
            let list = v["ops"]["classify_conflict"]["possible_rejections"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c.as_str() != Some("capability_unavailable"))
                .cloned()
                .collect::<Vec<_>>();
            v["ops"]["classify_conflict"]["possible_rejections"] = serde_json::json!(list);
        });
        assert!(PolicyTable::parse(&raw)
            .unwrap_err()
            .contains("capability_unavailable"));
    }

    #[test]
    fn a_registered_transition_no_op_allows_fails_the_load() {
        let raw = mutated(|v| {
            v["transitions"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!("zzz_orphan"));
            v["transitions"]
                .as_array_mut()
                .unwrap()
                .sort_by_key(|t| t.as_str().unwrap().to_string());
        });
        assert!(PolicyTable::parse(&raw).unwrap_err().contains("zzz_orphan"));
    }

    #[test]
    fn an_unsupported_format_still_fails_the_load() {
        // Widening to a SET is not the same as accepting anything: a table
        // from a build that knew more than this one must refuse, not be read
        // with the fields this build happens to recognise.
        let raw = mutated(|v| v["format"] = serde_json::json!(99));
        assert!(PolicyTable::parse(&raw)
            .unwrap_err()
            .contains("unsupported policy format 99"));
    }

    #[test]
    fn a_format_two_table_with_no_ancestry_binding_fails_the_load() {
        // The whole point of the version bump. A v2 that dropped the block
        // would look modern and gate nothing.
        let raw = mutated(|v| {
            v.as_object_mut().unwrap().remove("preventive_ancestry");
        });
        assert!(PolicyTable::parse(&raw)
            .unwrap_err()
            .contains("declares no preventive_ancestry binding"));
    }

    #[test]
    fn a_format_two_table_with_no_retry_rule_fails_the_load() {
        let raw = mutated(|v| {
            v.as_object_mut().unwrap().remove("in_session_retry");
        });
        assert!(PolicyTable::parse(&raw)
            .unwrap_err()
            .contains("declares no in_session_retry rule"));
    }

    #[test]
    fn a_retryable_code_that_is_not_a_code_fails_the_load() {
        let raw = mutated(|v| {
            v["in_session_retry"]["retryable_rejections"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!("aardvark_unavailable"));
        });
        assert!(PolicyTable::parse(&raw)
            .unwrap_err()
            .contains("in_session_retry.retryable_rejections"));
    }

    #[test]
    fn a_human_decision_can_never_be_made_retryable() {
        // Named in the loader rather than left to whoever edits the list
        // next. A human said no; asking again is not adjustment.
        let raw = mutated(|v| {
            let list = v["in_session_retry"]["retryable_rejections"]
                .as_array_mut()
                .unwrap();
            list.push(serde_json::json!("human_rejected"));
            list.sort_by_key(|c| c.as_str().unwrap().to_string());
        });
        assert!(PolicyTable::parse(&raw)
            .unwrap_err()
            .contains("not a stale precondition"));
    }

    #[test]
    fn zero_attempts_would_forbid_submitting_at_all() {
        let raw = mutated(|v| {
            v["in_session_retry"]["max_attempts"] = serde_json::json!(0);
        });
        assert!(PolicyTable::parse(&raw)
            .unwrap_err()
            .contains("counts the first attempt"));
    }

    #[test]
    fn retry_is_bounded_typed_and_never_granted_by_a_table_that_predates_it() {
        let table = PolicyTable::load().expect("the live table");
        // A stale precondition is the world moving under the request.
        assert_eq!(
            table.retry_verdict("stale_target_version", 1),
            RetryVerdict::Retry
        );
        // The bound counts the first attempt, so the third is the last.
        assert_eq!(
            table.retry_verdict("stale_target_version", 3),
            RetryVerdict::Exhausted
        );
        // A refusal about the substance of the change is not retryable at any
        // count — the two answers are distinct on purpose.
        assert_eq!(
            table.retry_verdict("self_ancestry", 0),
            RetryVerdict::NotRetryable
        );
        assert_eq!(
            table.retry_verdict("human_rejected", 0),
            RetryVerdict::NotRetryable
        );
        // The frozen v1 table has no rule, and absence is not permission.
        let v1 = PolicyTable::parse(POLICY_V1_JSON).expect("the frozen table");
        assert_eq!(
            v1.retry_verdict("stale_target_version", 0),
            RetryVerdict::NotRetryable
        );
    }

    #[test]
    fn every_retryable_code_is_one_some_op_can_actually_report() {
        // A code no op declares would be a retry rule for a refusal that
        // cannot happen — dead policy that reads as coverage.
        let table = PolicyTable::load().expect("the live table");
        let rule = table.in_session_retry.as_ref().expect("format 2 has one");
        for code in &rule.retryable_rejections {
            let reportable = table
                .ops
                .values()
                .any(|op| op.possible_rejections.contains(code))
                || table.transport_rejections.contains(code)
                || table.writer_rejections.contains(code)
                || table.mint_rejections.contains(code);
            assert!(reportable, "no op or channel can report {code:?}");
        }
    }

    #[test]
    fn a_bound_op_that_does_not_run_the_predicate_fails_the_load() {
        // The binding is three facts that must agree. This is the one that
        // would otherwise ship as protection: the block names the op, and
        // the op's row runs no walk.
        let raw = mutated(|v| {
            let requires = v["ops"]["update_belief"]["requires"]
                .as_array_mut()
                .unwrap();
            requires.retain(|p| p.as_str() != Some("no_self_ancestry"));
        });
        let err = PolicyTable::parse(&raw).unwrap_err();
        assert!(err.contains("its row does not"), "{err}");
    }

    #[test]
    fn a_bound_op_that_cannot_report_the_rejection_fails_the_load() {
        let raw = mutated(|v| {
            let codes = v["ops"]["update_belief"]["possible_rejections"]
                .as_array_mut()
                .unwrap();
            codes.retain(|c| c.as_str() != Some("self_ancestry"));
        });
        let err = PolicyTable::parse(&raw).unwrap_err();
        assert!(err.contains("cannot report"), "{err}");
    }

    #[test]
    fn an_op_that_runs_the_walk_outside_the_block_fails_the_load() {
        // The other direction, and the reason the block is the single
        // answer to "where does the gate run?": an op that requires the
        // predicate without being listed would make the block a partial map.
        let raw = mutated(|v| {
            let requires = v["ops"]["contest_belief"]["requires"]
                .as_array_mut()
                .unwrap();
            requires.push(serde_json::json!("no_self_ancestry"));
            requires.sort_by_key(|p| p.as_str().unwrap().to_string());
        });
        let err = PolicyTable::parse(&raw).unwrap_err();
        assert!(
            err.contains("preventive_ancestry does not list it"),
            "{err}"
        );
    }

    #[test]
    fn the_last_reserved_rejection_became_a_bound_one() {
        // `unbound_rejections` may now be empty, and in the shipped table it
        // is: every registered code an op can produce is declared by an op.
        // The list stays in the format because the NEXT reserved code will
        // need it.
        let table = PolicyTable::load().unwrap();
        assert!(table.unbound_rejections.is_empty());
        assert_eq!(table.destiny("self_ancestry"), Some(Destiny::Ledger));
    }

    #[test]
    fn silence_allows_only_transitions_that_cannot_resolve() {
        // The class-(a) invariant, read straight off the table: nothing in
        // the silence allowlist may be a lifecycle-ending transition.
        let table = PolicyTable::load().unwrap();
        for forbidden in [
            "supersede",
            "tombstone",
            "archive",
            "deprecate",
            "mass_supersede",
        ] {
            assert!(
                !table
                    .silence
                    .allowed_transitions
                    .iter()
                    .any(|t| t == forbidden),
                "silence must never permit {forbidden}"
            );
        }
        assert!(!table.silence.causes.is_empty());
    }

    #[test]
    fn every_op_carries_the_universal_preconditions() {
        // Actor binding, an exact target set, current versions, valid basis
        // refs, and the silence check are not per-op judgement calls.
        let table = PolicyTable::load().unwrap();
        for (name, op) in &table.ops {
            for predicate in [
                "actor_matches_run",
                "basis_refs_valid",
                "silence_transition_allowed",
                "target_set_exact",
                "versions_current",
            ] {
                assert!(
                    op.requires.iter().any(|p| p == predicate),
                    "{name} does not require {predicate}"
                );
            }
        }
    }

    #[test]
    fn only_reversible_ops_declare_a_one_click_inverse() {
        // The v1 inverse set is closed by the design; a sixth would need a
        // stored RevertPlan step kind that does not exist.
        let table = PolicyTable::load().unwrap();
        let reversible: BTreeSet<&str> = table
            .ops
            .iter()
            .filter(|(_, op)| op.revert == Revert::OneClick)
            .map(|(name, _)| name.as_str())
            .collect();
        assert_eq!(
            reversible,
            BTreeSet::from([
                "contest_belief",
                "edit_relation",
                "promote_draft",
                "supersede_belief",
                "update_belief",
            ])
        );
    }

    #[test]
    fn destiny_is_declared_for_every_code_an_op_can_produce() {
        let table = PolicyTable::load().unwrap();
        for (name, op) in &table.ops {
            for code in &op.possible_rejections {
                assert!(
                    table.destiny(code).is_some(),
                    "{name} can produce {code} with no declared destiny"
                );
            }
        }
    }
}
