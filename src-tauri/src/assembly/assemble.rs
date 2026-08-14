//! The assembler (M26.5c) — five intents in, one manifest out.
//!
//! Deterministic Rust, no model anywhere in it. A question plus a ledger head
//! produce exactly one manifest; the same question against the same base
//! produces the identical bytes. That is what lets M26.5d key a manifest by
//! its `assembly_id` and lets a reviewer re-run the search a receipt claims.
//!
//! **The five intents are not optional and not a search strategy.** They are
//! five different ways of being wrong, each closed by looking: what supports
//! this (positive), what disagrees with it (contradiction), what used to be
//! held (historical), who was entitled to say so (authority), and what is true
//! of the slice NEXT DOOR that a reader could mistake for the answer
//! (scope-neighbour). Every one records a terminal state, and there are only
//! three — `satisfied`, `exhausted`, `blocked`.
//!
//! **Counterevidence is never trimmed to fit.** Admission runs
//! contradiction-first, and if a contradicting item cannot be admitted under
//! the caps the assembler returns [`Refusal::CapConflict`] and there is NO
//! manifest — nothing is synthesized. Dropping the contradiction instead would
//! be invisible in the output and indistinguishable from there having been
//! none, which is the single failure this whole structure exists to prevent.
//! `blocked(cap_conflict)` on an intent record is the softer, spellable case:
//! some other intent lost everything to the caps, and the manifest says so.
//!
//! **The source cap bounds the SEARCH, not just the selection.** An attempt
//! records the sources its candidates came from, whether or not those
//! candidates were admitted — that is what makes "we looked here" checkable.
//! So `max_sources_per_run` cannot be satisfied by admitting fewer items, and
//! a question whose search reaches more sources than the cap allows is refused
//! rather than quietly narrowed. Un-looking is not a thing an honest record
//! can do.
//!
//! **Attended, therefore bounded and never budgeted.** See the module note on
//! `assembly`: no daily-run ceiling, no token gate, no yesterday's ambient
//! spend. The three caps here bound one request so it cannot run away, and
//! that is all they do.

use std::collections::{BTreeMap, BTreeSet};

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    normalize_alias_v1, sha256_first128, AuthorityProvenance, BeliefBasis, Lifecycle, RelationKind,
    Scope,
};
use crate::ledger::sha256_hex;
use crate::retrieval;

use super::corpus::Corpus;
use super::manifest::{
    Actual, Attempt, AttemptOutcome, BeliefContext, BlockedCounterevidence, BlockedReason,
    Counterevidence, ExhaustedReason, Intent, IntentRecord, IntentStatus, Intents, Limits,
    ManifestItem, QueryIntendedUse, SupportState, ValidTime, WorkingMemoryManifest,
};

/// The assembler generation a manifest was built by. A change to what the
/// intents REACH bumps this; a change to how a manifest is stored does not.
pub const ASSEMBLER_VERSION: &str = "assembly-v1";

/// The order items are admitted in when the caps bind.
///
/// A fixed, declared order — NOT a ranking. There is no score anywhere in this
/// module and the surrounding milestone forbids scalar salience outright; the
/// order is written down here so that two identical assemblies admit
/// identically, and so that a reader can see which intent yields first.
///
/// Contradiction leads because it is the one thing that must never be dropped
/// (and if it cannot fit, the assembly refuses rather than yields). Then what
/// the question asked about, then who was entitled to say it, then the
/// adjacent slice that could be mistaken for it, and last what the base no
/// longer holds.
const ADMISSION: [Intent; 5] = [
    Intent::Contradiction,
    Intent::Positive,
    Intent::Authority,
    Intent::ScopeNeighbor,
    Intent::Historical,
];

/// What a question is asked against.
pub struct Request<'a> {
    pub store_uuid: &'a str,
    /// The ledger head the search ran against. Part of `assembly_id`: the same
    /// question against a moved base is a different assembly, and a runtime
    /// table keyed by that id is idempotent for free.
    pub chain_head: &'a str,
    pub question: &'a str,
    /// Spellings the asker claims, beyond what the prose names.
    pub aliases: &'a [String],
    /// The slice the question is about. Anything the base holds in a
    /// CONFLICTING slice is a scope-neighbour rather than an answer.
    pub scope: Scope,
    pub intended_use: QueryIntendedUse,
    pub limits: Limits,
}

/// Why there is no manifest.
///
/// Each of these means "do not synthesize". A refusal is not a manifest with a
/// sad field in it, because a manifest exists to be cited and none of these
/// states can be honestly cited.
#[derive(Debug, Clone, PartialEq)]
pub enum Refusal {
    /// Accessible counterevidence would not fit under the caps. §22's hard
    /// stop.
    CapConflict { detail: String },
    /// The retriever could not run and could not name what it failed to
    /// reach, so nothing truthful can be said about the counterevidence —
    /// not `included`, not `exhausted` (which claims a completed look), and
    /// not `blocked` (which must name the sources it could not reach).
    RetrievalUnavailable { detail: String },
    /// The assembler selected something it cannot describe honestly — a
    /// belief revision whose basis the projection does not hold, or an
    /// assertion whose bytes the corpus could not read.
    ///
    /// This is a refusal rather than a skip because a skip is invisible. The
    /// dropped item might have been the counterevidence, and the manifest
    /// would then have recorded `exhausted` — "we looked and there is none" —
    /// about a disagreement it had found and could not read. A rebuild or a
    /// recovery is the answer; an answer with a known hole in it is not.
    Incoherent { detail: String },
    /// The assembler built a manifest its own validator rejects. A bug,
    /// surfaced rather than shipped.
    Invalid { detail: String },
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::CapConflict { detail } => write!(f, "cap conflict: {detail}"),
            Refusal::RetrievalUnavailable { detail } => {
                write!(f, "retrieval unavailable: {detail}")
            }
            Refusal::Incoherent { detail } => {
                write!(f, "the base could not be described: {detail}")
            }
            Refusal::Invalid { detail } => write!(f, "assembled an invalid manifest: {detail}"),
        }
    }
}

/// One assembled question.
#[derive(Debug, Clone, PartialEq)]
pub struct Assembly {
    pub manifest: WorkingMemoryManifest,
    /// `item_id` → the exact bytes counted and hashed. M26.5e's prompt prints
    /// these verbatim; the manifest's `byte_count` and `content_hash` are
    /// computed from the same strings, which is the only way
    /// `max_context_bytes` can mean anything.
    pub rendered: BTreeMap<String, String>,
}

/// A retriever that could not run, and what it could not reach.
///
/// `sources` is the difference between a manifest and a refusal: naming the
/// sources it failed on is what lets counterevidence be recorded as `blocked`.
/// An empty list means nothing truthful can be said, and the assembly refuses.
#[derive(Debug, Clone, PartialEq)]
pub struct Unreachable {
    pub detail: String,
    pub sources: Vec<String>,
}

pub type Reach = Result<Vec<String>, Unreachable>;

/// The expansion step, injected so its failure path is real.
///
/// `expansion-v1` reads state already in memory and cannot fail — which is
/// exactly why the blocked branches here would otherwise be code nobody has
/// ever seen run. The trait lets a test drive them, and lets the next
/// retriever (a model that will not load, an index that will not open) fail
/// without this module changing.
pub trait Retriever {
    fn expand(&self, state: &EpistemicState, query: &retrieval::Query) -> Reach;
}

/// M26.2's graph expansion.
pub struct Expansion;

impl Retriever for Expansion {
    fn expand(&self, state: &EpistemicState, query: &retrieval::Query) -> Reach {
        retrieval::candidates(state, query).map_err(|detail| Unreachable {
            detail,
            sources: vec![],
        })
    }
}

/// One thing that could be shown, before the caps have had their say.
struct Candidate {
    item_id: String,
    statement: String,
    sources: Vec<String>,
    intents: BTreeSet<Intent>,
    build: Built,
}

/// The item-shaped half of a candidate, kept apart so `selected_by_intents`
/// can be filled in once at the end from the merged intent set.
enum Built {
    Assertion {
        assertion_event_id: String,
        belief_context: BeliefContext,
        source_id: String,
        lineage_event_ids: Vec<String>,
        scope: Scope,
        valid_time: ValidTime,
    },
    BeliefRevision {
        belief_id: String,
        belief_revision_event_id: String,
        basis_observation_event_ids: Vec<String>,
        lineage_event_ids: Vec<String>,
        support_state: SupportState,
    },
}

/// Assemble one question.
pub fn assemble<R: Retriever>(
    state: &EpistemicState,
    corpus: &Corpus,
    retriever: &R,
    request: &Request<'_>,
) -> Result<Assembly, Refusal> {
    let subjects = subjects_of(state, request);
    let aliases = alias_expansion(state, &subjects);

    // The one fallible step. Its failure decides whether there can be a
    // manifest at all, so it runs before anything is built.
    let expanded = match expand(state, retriever, &subjects, request) {
        Ok(reached) => Ok(reached),
        Err(unreachable) if unreachable.sources.is_empty() => {
            return Err(Refusal::RetrievalUnavailable {
                detail: unreachable.detail,
            })
        }
        Err(unreachable) => Err(unreachable),
    };

    let mut pool: BTreeMap<String, Candidate> = BTreeMap::new();
    let mut found: BTreeMap<Intent, Vec<String>> = BTreeMap::new();
    for intent in Intent::ALL {
        let ids = match (&expanded, needs_expansion(intent)) {
            (Err(_), true) => Vec::new(),
            (reached, _) => {
                let reached = reached.as_deref().unwrap_or(&[]);
                collect(
                    state, corpus, request, &subjects, reached, intent, &mut pool,
                )
                .map_err(|detail| Refusal::Incoherent { detail })?
            }
        };
        found.insert(intent, ids);
    }

    let attempts = attempts_for(request, &subjects, &aliases, &found, &pool, &expanded);
    let admitted = admit(request, &pool, &attempts)?;

    let items: Vec<ManifestItem> = admitted.iter().map(|id| build_item(&pool[id])).collect();
    let rendered: BTreeMap<String, String> = admitted
        .iter()
        .map(|id| (id.clone(), pool[id].statement.clone()))
        .collect();

    let intents = intent_records(&found, &admitted, &attempts, &expanded);
    let counterevidence = counterevidence(&found, &admitted, &attempts, &expanded);

    let manifest = WorkingMemoryManifest {
        assembly_id: assembly_id(request),
        question_hash: question_hash(request.question),
        intended_use: request.intended_use.clone(),
        limits: request.limits,
        actual: Actual {
            source_count: 0,
            context_bytes: 0,
            evidence_item_count: 0,
        },
        intents,
        items,
        counterevidence,
    };
    let manifest = with_actuals(manifest);
    manifest
        .validate()
        .map_err(|detail| Refusal::Invalid { detail })?;
    Ok(Assembly { manifest, rendered })
}

/// Count what was actually used, from the manifest itself rather than from a
/// tally kept alongside it — a second counter is a second thing to disagree.
fn with_actuals(mut manifest: WorkingMemoryManifest) -> WorkingMemoryManifest {
    manifest.actual = Actual {
        source_count: manifest.distinct_sources().len() as u64,
        context_bytes: manifest.items.iter().map(ManifestItem::byte_count).sum(),
        evidence_item_count: manifest.items.len() as u64,
    };
    manifest
}

/// Every entity the question reaches: what its prose names, plus the
/// spellings the asker claimed.
fn subjects_of(state: &EpistemicState, request: &Request<'_>) -> BTreeSet<String> {
    let mut subjects = retrieval::entities_named_in(state, request.question);
    for alias in request.aliases {
        if let Some(hit) = state.alias_registry.get(&normalize_alias_v1(alias)) {
            subjects.insert(hit.entity_id.clone());
        }
    }
    subjects
}

/// Every spelling the base knows for the subjects — the alias expansion an
/// attempt records, so a reader can see the search was not limited to the
/// words the asker happened to use.
fn alias_expansion(state: &EpistemicState, subjects: &BTreeSet<String>) -> Vec<String> {
    let mut aliases: Vec<String> = state
        .alias_registry
        .values()
        .filter(|alias| subjects.contains(&alias.entity_id))
        .map(|alias| alias.normalized.clone())
        .collect();
    aliases.sort();
    aliases.dedup();
    aliases
}

/// Which intents cannot be run without the expansion step.
///
/// Contradiction needs it because the belief that disagrees may be about an
/// entity the question never named, reachable only across the graph — so a
/// retriever that cannot expand cannot claim to have looked for
/// counterevidence. Scope-neighbour needs it for its graph leg.
fn needs_expansion(intent: Intent) -> bool {
    matches!(intent, Intent::Contradiction | Intent::ScopeNeighbor)
}

fn expand<R: Retriever>(
    state: &EpistemicState,
    retriever: &R,
    subjects: &BTreeSet<String>,
    request: &Request<'_>,
) -> Result<Vec<String>, Unreachable> {
    let mut reached: BTreeSet<String> = BTreeSet::new();
    for subject in subjects {
        let query = retrieval::Query {
            subject_id: subject,
            content: request.question,
            aliases: request.aliases,
        };
        reached.extend(retriever.expand(state, &query)?);
    }
    Ok(reached.into_iter().collect())
}

/// Gather one intent's candidates into the shared pool, returning their item
/// ids. A candidate several intents want is ONE pool entry with several
/// intents recorded — an item is shown once and accounted for once.
fn collect(
    state: &EpistemicState,
    corpus: &Corpus,
    request: &Request<'_>,
    subjects: &BTreeSet<String>,
    expanded: &[String],
    intent: Intent,
    pool: &mut BTreeMap<String, Candidate>,
) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    match intent {
        Intent::Positive => {
            for belief in live_beliefs_about(state, subjects) {
                let revision = current_revision(state, belief);
                push_belief(state, pool, &mut ids, intent, belief, revision)?;
            }
            for observation in assertions_about(state, subjects) {
                if !scope_compatible(&scope_of(corpus, observation)?, &request.scope) {
                    continue;
                }
                push_assertion(state, corpus, pool, &mut ids, intent, observation)?;
            }
        }
        Intent::Contradiction => {
            let near: BTreeSet<&str> = live_beliefs_about(state, subjects)
                .into_iter()
                .chain(expanded.iter().map(String::as_str))
                .collect();
            for belief_id in contradicting(state, &near) {
                let revision = current_revision(state, &belief_id);
                push_belief(state, pool, &mut ids, intent, &belief_id, revision)?;
            }
        }
        Intent::Historical => {
            for belief_id in state.beliefs.keys() {
                let belief = &state.beliefs[belief_id];
                if !subjects.contains(&belief.entity_id) {
                    continue;
                }
                // What the base no longer holds: a retired belief, and every
                // revision before the current one. A prior revision is its own
                // item because it has its own event id and its own basis.
                let retired = belief.tombstoned_by.is_some()
                    || !matches!(belief.lifecycle, Lifecycle::Active);
                let current = belief.current().event_id.as_str();
                for revision in &belief.revisions {
                    if revision.event_id == current && !retired {
                        continue;
                    }
                    push_belief(state, pool, &mut ids, intent, belief_id, Some(revision))?;
                }
            }
        }
        Intent::Authority => {
            // Any slice, deliberately. An authoritative claim about the stage
            // next door still answers "who was entitled to say this", and it
            // is also selected by scope-neighbour — so `selected_by_intents`
            // tells a reader both things rather than the manifest having to
            // choose one of them to report.
            for observation in assertions_about(state, subjects) {
                if !authoritative(state, observation) {
                    continue;
                }
                push_assertion(state, corpus, pool, &mut ids, intent, observation)?;
            }
            // A belief resting on an authoritative assertion is itself part of
            // the authority answer: the question "who was entitled to say
            // this" is about the basis, not about who typed the belief.
            for belief_id in live_beliefs_about(state, subjects) {
                let Some(revision) = current_revision(state, belief_id) else {
                    continue;
                };
                let BeliefBasis::Linked { links } = &revision.basis else {
                    continue;
                };
                if links
                    .iter()
                    .any(|link| authoritative(state, &link.observation_event_id))
                {
                    push_belief(state, pool, &mut ids, intent, belief_id, Some(revision))?;
                }
            }
        }
        Intent::ScopeNeighbor => {
            // Leg one: the same subject, a conflicting slice.
            for observation in assertions_about(state, subjects) {
                if scope_compatible(&scope_of(corpus, observation)?, &request.scope) {
                    continue;
                }
                push_assertion(state, corpus, pool, &mut ids, intent, observation)?;
            }
            // Leg two: one relation hop out, about something else. The
            // neighbour in the graph, which a reader can equally mistake for
            // an answer about the thing they asked about.
            for belief_id in expanded {
                let Some(belief) = state.beliefs.get(belief_id) else {
                    continue;
                };
                if subjects.contains(&belief.entity_id) || belief.tombstoned_by.is_some() {
                    continue;
                }
                let revision = current_revision(state, belief_id);
                push_belief(state, pool, &mut ids, intent, belief_id, revision)?;
            }
        }
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn live_beliefs_about<'a>(state: &'a EpistemicState, subjects: &BTreeSet<String>) -> Vec<&'a str> {
    state
        .beliefs
        .values()
        .filter(|belief| subjects.contains(&belief.entity_id) && belief.tombstoned_by.is_none())
        .map(|belief| belief.belief_id.as_str())
        .collect()
}

/// Assertion Observations currently attached to one of the subjects.
fn assertions_about<'a>(state: &'a EpistemicState, subjects: &BTreeSet<String>) -> Vec<&'a str> {
    state
        .observations
        .values()
        .filter(|observation| {
            observation.kind.is_assertion()
                && observation
                    .effective_entity
                    .as_deref()
                    .is_some_and(|entity| subjects.contains(entity))
        })
        .map(|observation| observation.event_id.as_str())
        .collect()
}

/// D11: `agent_inferred` is a claim, never authority. Only a trusted human
/// capture or a registered direct artifact answers "who was entitled to say
/// so".
fn authoritative(state: &EpistemicState, observation_event_id: &str) -> bool {
    state
        .observations
        .get(observation_event_id)
        .and_then(|observation| observation.authority)
        .is_some_and(|authority| {
            matches!(
                authority,
                AuthorityProvenance::TrustedHumanCapture
                    | AuthorityProvenance::RegisteredDirectArtifact
            )
        })
}

/// Beliefs a LIVE `contradicts` edge joins to anything in `near`, from either
/// end. Direction-blind: an edge is one fact recorded from one end, and
/// reading only outgoing edges would surface the counterevidence for whichever
/// belief happened to be written second.
fn contradicting(state: &EpistemicState, near: &BTreeSet<&str>) -> Vec<String> {
    let mut out = BTreeSet::new();
    for relation in state.relations.values() {
        if !relation.live || relation.relation != RelationKind::Contradicts {
            continue;
        }
        for (end, other) in [
            (relation.from.as_str(), relation.to.as_str()),
            (relation.to.as_str(), relation.from.as_str()),
        ] {
            if near.contains(end) && state.beliefs.contains_key(other) {
                out.insert(other.to_string());
            }
        }
    }
    out.into_iter().collect()
}

fn current_revision<'a>(
    state: &'a EpistemicState,
    belief_id: &str,
) -> Option<&'a crate::ledger::reduce::RevisionState> {
    state.beliefs.get(belief_id).map(|belief| belief.current())
}

/// Two scopes conflict when they both name a field and name it differently.
/// A field one of them leaves open is a field it makes no claim about, so it
/// cannot disagree.
fn scope_compatible(item: &Scope, ask: &Scope) -> bool {
    fn agree<T: PartialEq>(a: &Option<T>, b: &Option<T>) -> bool {
        match (a, b) {
            (Some(left), Some(right)) => left == right,
            _ => true,
        }
    }
    agree(&item.stage, &ask.stage)
        && agree(&item.revision, &ask.revision)
        && agree(&item.environment, &ask.environment)
        && agree(&item.geography, &ask.geography)
}

/// The scope the corpus holds for one assertion. Err when it holds none: see
/// [`Refusal::Incoherent`] — an assertion whose bytes cannot be read cannot be
/// placed in or out of the question's slice, and guessing either way is a
/// claim about evidence nobody has seen.
fn scope_of(corpus: &Corpus, observation_event_id: &str) -> Result<Scope, String> {
    corpus
        .get(observation_event_id)
        .map(|assertion| assertion.scope.clone())
        .ok_or_else(|| {
            format!("assertion {observation_event_id} is in the projection and not in the ledger                      this assembly could read")
        })
}

fn push_belief(
    state: &EpistemicState,
    pool: &mut BTreeMap<String, Candidate>,
    ids: &mut Vec<String>,
    intent: Intent,
    belief_id: &str,
    revision: Option<&crate::ledger::reduce::RevisionState>,
) -> Result<(), String> {
    let (Some(revision), Some(belief)) = (revision, state.beliefs.get(belief_id)) else {
        return Err(format!(
            "belief {belief_id} was selected and the projection does not hold it"
        ));
    };
    let item_id = belief_item_id(belief_id, &revision.event_id);
    ids.push(item_id.clone());
    if let Some(existing) = pool.get_mut(&item_id) {
        existing.intents.insert(intent);
        return Ok(());
    }

    let (basis, sources, support_state) = match &revision.basis {
        BeliefBasis::Unsupported { .. } => (vec![], vec![], SupportState::Unsupported),
        BeliefBasis::Linked { links } => {
            let basis: Vec<String> = links
                .iter()
                .map(|link| link.observation_event_id.clone())
                .collect();
            let mut sources: Vec<String> = basis
                .iter()
                .filter_map(|id| state.observations.get(id))
                .map(|observation| observation.source_id.clone())
                .collect();
            sources.sort();
            sources.dedup();
            if sources.is_empty() {
                // A linked revision whose basis resolves to no source cannot
                // be described honestly — `linked` with no source is exactly
                // the shape the manifest calls a fabricated source. Refusing
                // rather than skipping is the point: the skipped item might
                // have been the counterevidence, and the manifest would then
                // have said `exhausted` about a disagreement it had found.
                return Err(format!(
                    "belief revision {} is linked and its basis observations are not in the                      projection",
                    revision.event_id
                ));
            }
            (basis, sources, SupportState::Linked)
        }
    };

    // The belief's own history is its lineage: every revision before this one.
    let lineage_event_ids: Vec<String> = belief
        .revisions
        .iter()
        .take_while(|earlier| earlier.revision < revision.revision)
        .map(|earlier| earlier.event_id.clone())
        .collect();

    pool.insert(
        item_id.clone(),
        Candidate {
            item_id,
            statement: revision.content.clone(),
            sources,
            intents: BTreeSet::from([intent]),
            build: Built::BeliefRevision {
                belief_id: belief_id.to_string(),
                belief_revision_event_id: revision.event_id.clone(),
                basis_observation_event_ids: basis,
                lineage_event_ids,
                support_state,
            },
        },
    );
    Ok(())
}

fn push_assertion(
    state: &EpistemicState,
    corpus: &Corpus,
    pool: &mut BTreeMap<String, Candidate>,
    ids: &mut Vec<String>,
    intent: Intent,
    observation_event_id: &str,
) -> Result<(), String> {
    let item_id = assertion_item_id(observation_event_id);
    ids.push(item_id.clone());
    if let Some(existing) = pool.get_mut(&item_id) {
        existing.intents.insert(intent);
        return Ok(());
    }
    let (Some(assertion), Some(observation)) = (
        corpus.get(observation_event_id),
        state.observations.get(observation_event_id),
    ) else {
        return Err(format!(
            "assertion {observation_event_id} was selected and could not be read"
        ));
    };

    pool.insert(
        item_id.clone(),
        Candidate {
            item_id,
            statement: assertion.statement.clone(),
            sources: vec![observation.source_id.clone()],
            intents: BTreeSet::from([intent]),
            build: Built::Assertion {
                assertion_event_id: observation_event_id.to_string(),
                belief_context: belief_context(state, observation_event_id),
                source_id: observation.source_id.clone(),
                lineage_event_ids: observation
                    .lineage_parents
                    .iter()
                    .map(|(_, parent)| parent.clone())
                    .collect(),
                scope: assertion.scope.clone(),
                valid_time: ValidTime {
                    from: assertion.valid_from.clone(),
                    to: assertion.valid_to.clone(),
                },
            },
        },
    );
    Ok(())
}

/// Does the base hold a belief that rests on this assertion? `supported_at`
/// says which revision, so a reader can tell an assertion the base ACTED on
/// from one it merely holds.
///
/// **Tombstoned beliefs do not count.** "The base acted on this" is exactly
/// the claim a retraction withdraws, so naming a tombstoned belief here would
/// invert the field's meaning — and worse, the winner among several candidates
/// is decided by hex id order, so a re-ingest that minted a lower id could
/// silently change what an assertion is said to support.
fn belief_context(state: &EpistemicState, observation_event_id: &str) -> BeliefContext {
    for belief in state.beliefs.values() {
        if belief.tombstoned_by.is_some() {
            continue;
        }
        let revision = belief.current();
        let BeliefBasis::Linked { links } = &revision.basis else {
            continue;
        };
        if links
            .iter()
            .any(|link| link.observation_event_id == observation_event_id)
        {
            return BeliefContext::SupportedAt {
                belief_id: belief.belief_id.clone(),
                belief_revision_event_id: revision.event_id.clone(),
            };
        }
    }
    BeliefContext::None
}

/// Admit in [`ADMISSION`] order until a cap would break.
///
/// A contradiction item that will not fit ends the assembly — see the module
/// note. Everything else simply is not admitted, and the intent that wanted it
/// records `blocked(cap_conflict)`.
fn admit(
    request: &Request<'_>,
    pool: &BTreeMap<String, Candidate>,
    attempts: &BTreeMap<Intent, Attempt>,
) -> Result<Vec<String>, Refusal> {
    // Fixed before a single item is chosen: an attempt's sources are the
    // record of where it looked, and admitting fewer items cannot un-look.
    // This is exactly what the manifest will count, so the check here and the
    // validator's cannot disagree.
    let searched: BTreeSet<&str> = attempts
        .values()
        .flat_map(|attempt| attempt.source_ids.iter().map(String::as_str))
        .collect();
    if searched.len() as u64 > request.limits.max_sources_per_run {
        return Err(Refusal::CapConflict {
            detail: format!(
                "the search reached {} sources and max_sources_per_run is {} — narrowing the \
                 selection cannot unsee a source an attempt recorded",
                searched.len(),
                request.limits.max_sources_per_run
            ),
        });
    }

    let mut admitted: Vec<String> = Vec::new();
    let mut taken: BTreeSet<&str> = BTreeSet::new();
    let mut bytes = 0u64;
    for intent in ADMISSION {
        let mut wanted: Vec<&Candidate> = pool
            .values()
            .filter(|candidate| candidate.intents.contains(&intent))
            .collect();
        wanted.sort_by(|a, b| a.item_id.cmp(&b.item_id));
        for candidate in wanted {
            if taken.contains(candidate.item_id.as_str()) {
                continue;
            }
            let size = candidate.statement.len() as u64;
            let fits = bytes + size <= request.limits.max_context_bytes
                && (admitted.len() as u64) < request.limits.max_evidence_items;
            if !fits {
                if intent == Intent::Contradiction {
                    return Err(Refusal::CapConflict {
                        detail: format!(
                            "accessible counterevidence ({}) does not fit under the caps, and \
                             trimming it would be invisible in the answer",
                            candidate.item_id
                        ),
                    });
                }
                continue;
            }
            bytes += size;
            taken.insert(candidate.item_id.as_str());
            admitted.push(candidate.item_id.clone());
        }
    }
    admitted.sort();
    Ok(admitted)
}

fn build_item(candidate: &Candidate) -> ManifestItem {
    let selected_by_intents: Vec<Intent> = candidate.intents.iter().copied().collect();
    let content_hash = sha256_hex(candidate.statement.as_bytes());
    let byte_count = candidate.statement.len() as u64;
    match &candidate.build {
        Built::Assertion {
            assertion_event_id,
            belief_context,
            source_id,
            lineage_event_ids,
            scope,
            valid_time,
        } => ManifestItem::Assertion {
            item_id: candidate.item_id.clone(),
            assertion_event_id: assertion_event_id.clone(),
            belief_context: belief_context.clone(),
            source_id: source_id.clone(),
            content_hash,
            selected_by_intents,
            lineage_event_ids: lineage_event_ids.clone(),
            state_stage: scope.stage,
            scope: scope.clone(),
            valid_time: valid_time.clone(),
            byte_count,
        },
        Built::BeliefRevision {
            belief_id,
            belief_revision_event_id,
            basis_observation_event_ids,
            lineage_event_ids,
            support_state,
            ..
        } => ManifestItem::BeliefRevision {
            item_id: candidate.item_id.clone(),
            belief_id: belief_id.clone(),
            belief_revision_event_id: belief_revision_event_id.clone(),
            basis_observation_event_ids: basis_observation_event_ids.clone(),
            source_ids: candidate.sources.clone(),
            content_hash,
            selected_by_intents,
            lineage_event_ids: lineage_event_ids.clone(),
            // A Belief in this tree carries no scope and no validity window:
            // scope is a property of the assertions underneath it, and
            // inventing one here would be a claim the base never made.
            scope: Scope::empty(),
            state_stage: None,
            valid_time: ValidTime::unbounded(),
            byte_count,
            support_state: *support_state,
        },
    }
}

/// One attempt per intent, recorded whether or not it found anything.
fn attempts_for(
    request: &Request<'_>,
    subjects: &BTreeSet<String>,
    aliases: &[String],
    found: &BTreeMap<Intent, Vec<String>>,
    pool: &BTreeMap<String, Candidate>,
    expanded: &Result<Vec<String>, Unreachable>,
) -> BTreeMap<Intent, Attempt> {
    let assembly = assembly_id(request);
    let mut attempts = BTreeMap::new();
    for intent in Intent::ALL {
        let blocked = expanded.as_ref().err().filter(|_| needs_expansion(intent));
        let candidates = found.get(&intent).cloned().unwrap_or_default();
        let mut sources: Vec<String> = match blocked {
            Some(unreachable) => unreachable.sources.clone(),
            None => candidates
                .iter()
                .filter_map(|id| pool.get(id))
                .flat_map(|candidate| candidate.sources.clone())
                .collect(),
        };
        sources.sort();
        sources.dedup();
        let outcome = match (blocked, candidates.is_empty()) {
            (Some(_), _) => AttemptOutcome::SourceInaccessible,
            (None, true) => AttemptOutcome::NoCandidates,
            (None, false) => AttemptOutcome::CandidatesFound,
        };
        attempts.insert(
            intent,
            Attempt {
                attempt_id: format!("{assembly}:{}", intent.as_str()),
                query_hash: query_hash(request, intent, subjects),
                expanded_aliases: aliases.to_vec(),
                source_ids: sources,
                candidate_item_ids: if blocked.is_some() {
                    Vec::new()
                } else {
                    candidates
                },
                outcome,
            },
        );
    }
    attempts
}

fn intent_records(
    found: &BTreeMap<Intent, Vec<String>>,
    admitted: &[String],
    attempts: &BTreeMap<Intent, Attempt>,
    expanded: &Result<Vec<String>, Unreachable>,
) -> Intents {
    let record = |intent: Intent| -> IntentRecord {
        let attempt = attempts[&intent].clone();
        let candidates = found.get(&intent).cloned().unwrap_or_default();
        let selected: Vec<String> = candidates
            .iter()
            .filter(|id| admitted.contains(id))
            .cloned()
            .collect();
        let blocked = expanded.is_err() && needs_expansion(intent);
        let (status, blocked_reason) = if blocked {
            (
                IntentStatus::Blocked,
                Some(BlockedReason::SourceInaccessible),
            )
        } else if !selected.is_empty() {
            (IntentStatus::Satisfied, None)
        } else if candidates.is_empty() {
            (IntentStatus::Exhausted, None)
        } else {
            // It found things and the caps kept them out. Contradiction can
            // never reach here — that path refuses the whole assembly.
            (IntentStatus::Blocked, Some(BlockedReason::CapConflict))
        };
        IntentRecord {
            status,
            attempts: vec![attempt],
            selected_item_ids: selected,
            blocked_reason,
        }
    };
    Intents {
        positive: record(Intent::Positive),
        contradiction: record(Intent::Contradiction),
        historical: record(Intent::Historical),
        authority: record(Intent::Authority),
        scope_neighbor: record(Intent::ScopeNeighbor),
    }
}

fn counterevidence(
    found: &BTreeMap<Intent, Vec<String>>,
    admitted: &[String],
    attempts: &BTreeMap<Intent, Attempt>,
    expanded: &Result<Vec<String>, Unreachable>,
) -> Counterevidence {
    let attempt = &attempts[&Intent::Contradiction];
    if let Err(unreachable) = expanded {
        return Counterevidence::Blocked {
            attempt_refs: vec![attempt.attempt_id.clone()],
            source_ids: unreachable.sources.clone(),
            reason: BlockedCounterevidence::SourceInaccessible,
        };
    }
    let selected: Vec<String> = found
        .get(&Intent::Contradiction)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|id| admitted.contains(id))
        .collect();
    if selected.is_empty() {
        Counterevidence::Exhausted {
            attempt_refs: vec![attempt.attempt_id.clone()],
            source_ids: attempt.source_ids.clone(),
            reason: ExhaustedReason::NoCandidates,
        }
    } else {
        Counterevidence::Included { item_ids: selected }
    }
}

/// `sha256("cerebro-assembly-question-v1\0" + normalized question)`.
fn question_hash(question: &str) -> String {
    let mut bytes = b"cerebro-assembly-question-v1\0".to_vec();
    bytes.extend_from_slice(normalize_alias_v1(question).as_bytes());
    sha256_hex(&bytes)
}

/// The assembly's identity: this question, asked THIS way, for this use, under
/// these caps, against this base. Server-derived and content-addressed, so
/// re-asking an unchanged question against an unchanged ledger is idempotent.
///
/// **Every input that changes what the search reaches is in here**, and the
/// claimed spellings are one of them: `subjects_of` resolves them to entities
/// and `expand` hands them to the retriever, so the same prose with an extra
/// alias is a different search that can find a contradiction the bare one
/// misses. Leaving them out made two different manifests share an id — which
/// broke idempotency in the worst available direction, because a reader
/// fetching that id could be handed the search that reported `exhausted`
/// about a disagreement the other one had found.
fn assembly_id(request: &Request<'_>) -> String {
    let mut aliases: Vec<String> = request
        .aliases
        .iter()
        .map(|alias| normalize_alias_v1(alias))
        .collect();
    aliases.sort();
    aliases.dedup();
    let body = serde_json::json!({
        "assembler": ASSEMBLER_VERSION,
        "store_uuid": request.store_uuid,
        "chain_head": request.chain_head,
        "question_hash": question_hash(request.question),
        "aliases": aliases,
        "intended_use": request.intended_use,
        "limits": request.limits,
        "scope": request.scope,
    });
    let mut bytes = b"cerebro-assembly-v1\0".to_vec();
    bytes.extend_from_slice(body.to_string().as_bytes());
    sha256_first128(&bytes)
}

/// What one intent searched for. Covers the intent, the subjects it ran
/// against, the question and the slice — everything that changes what the
/// search reaches.
fn query_hash(request: &Request<'_>, intent: Intent, subjects: &BTreeSet<String>) -> String {
    let body = serde_json::json!({
        "intent": intent.as_str(),
        "question_hash": question_hash(request.question),
        "scope": request.scope,
        // The RESOLVED subjects, which already carry whatever the claimed
        // spellings reached — this is what the search actually ran against.
        "subjects": subjects.iter().collect::<Vec<_>>(),
    });
    let mut bytes = b"cerebro-assembly-query-v1\0".to_vec();
    bytes.extend_from_slice(body.to_string().as_bytes());
    sha256_hex(&bytes)
}

fn belief_item_id(belief_id: &str, revision_event: &str) -> String {
    let mut bytes = b"cerebro-assembly-item-v1\0belief\0".to_vec();
    bytes.extend_from_slice(belief_id.as_bytes());
    bytes.push(0);
    bytes.extend_from_slice(revision_event.as_bytes());
    sha256_first128(&bytes)
}

fn assertion_item_id(assertion_event_id: &str) -> String {
    let mut bytes = b"cerebro-assembly-item-v1\0assertion\0".to_vec();
    bytes.extend_from_slice(assertion_event_id.as_bytes());
    sha256_first128(&bytes)
}

#[cfg(test)]
mod tests {
    use super::super::fixture::*;
    use super::*;

    struct Unavailable {
        sources: Vec<String>,
    }

    impl Retriever for Unavailable {
        fn expand(&self, _: &EpistemicState, _: &retrieval::Query) -> Reach {
            Err(Unreachable {
                detail: "the index would not open".into(),
                sources: self.sources.clone(),
            })
        }
    }

    #[test]
    fn every_intent_reports_and_the_manifest_validates() {
        let assembly = assembled(&request(shipping(), wide()));
        assembly.manifest.validate().expect("its own validator");
        for intent in Intent::ALL {
            let record = assembly.manifest.intents.get(intent);
            assert_eq!(
                record.attempts.len(),
                1,
                "{} recorded no search — an intent that did not look cannot report",
                intent.as_str()
            );
        }
    }

    #[test]
    fn a_disagreement_the_base_already_holds_is_included_as_counterevidence() {
        let assembly = assembled(&request(shipping(), wide()));
        let Counterevidence::Included { item_ids } = &assembly.manifest.counterevidence else {
            panic!(
                "expected included, got {:?}",
                assembly.manifest.counterevidence
            );
        };
        // BOTH ends. A `contradicts` edge is one disagreement, and showing one
        // side of it would be showing the base's opinion rather than the
        // base's problem.
        assert_eq!(item_ids.len(), 2, "{item_ids:?}");
        assert_eq!(
            assembly.manifest.intents.contradiction.status,
            IntentStatus::Satisfied
        );
    }

    #[test]
    fn counterevidence_that_will_not_fit_refuses_the_whole_assembly() {
        // The one failure the structure exists to prevent: trimming the
        // contradiction to fit would be invisible in the answer.
        let refusal = assemble(
            &state(),
            &corpus(),
            &Expansion,
            &request(shipping(), limits(10, 10, 100)),
        )
        .expect_err("a cap that cannot hold the counterevidence refuses");
        assert!(
            matches!(refusal, Refusal::CapConflict { .. }),
            "{refusal:?}"
        );
    }

    #[test]
    fn an_intent_that_loses_everything_to_the_caps_says_so_and_the_manifest_lives() {
        // Admission order puts historical last, so a tight item cap starves it
        // while the counterevidence still fits. The manifest exists and says
        // `blocked(cap_conflict)` rather than quietly reporting nothing there.
        let wide = assembled(&request(shipping(), wide()));
        let historical = wide.manifest.intents.historical.selected_item_ids.len();
        assert!(historical > 0, "the fixture has a prior revision to lose");
        let tight = wide.manifest.items.len() as u64 - historical as u64;

        let assembly = assemble(
            &state(),
            &corpus(),
            &Expansion,
            &request(shipping(), limits(10, 100_000, tight)),
        )
        .expect("the manifest survives");
        assert_eq!(
            assembly.manifest.intents.historical.status,
            IntentStatus::Blocked
        );
        assert_eq!(
            assembly.manifest.intents.historical.blocked_reason,
            Some(BlockedReason::CapConflict)
        );
        assert!(matches!(
            assembly.manifest.counterevidence,
            Counterevidence::Included { .. }
        ));
    }

    #[test]
    fn a_search_wider_than_the_source_cap_is_refused_rather_than_narrowed() {
        // Un-looking is not available: an attempt records where it looked, so
        // admitting fewer items cannot bring the source count down.
        let refusal = assemble(
            &state(),
            &corpus(),
            &Expansion,
            &request(shipping(), limits(1, 100_000, 100)),
        )
        .expect_err("three sources under a cap of one");
        let Refusal::CapConflict { detail } = refusal else {
            panic!("expected a cap conflict");
        };
        assert!(detail.contains("unsee"), "{detail}");
    }

    #[test]
    fn a_retriever_that_cannot_name_what_it_missed_refuses_the_assembly() {
        // Nothing truthful can be said about the counterevidence: not
        // included, not exhausted (which claims a completed look), and not
        // blocked (which must name the sources it could not reach).
        let refusal = assemble(
            &state(),
            &corpus(),
            &Unavailable { sources: vec![] },
            &request(shipping(), wide()),
        )
        .expect_err("no manifest");
        assert!(matches!(refusal, Refusal::RetrievalUnavailable { .. }));
    }

    #[test]
    fn a_retriever_that_names_what_it_missed_yields_blocked_counterevidence() {
        let assembly = assemble(
            &state(),
            &corpus(),
            &Unavailable {
                sources: vec![SOURCE_A.into()],
            },
            &request(shipping(), wide()),
        )
        .expect("a manifest that says what it could not see");
        let Counterevidence::Blocked {
            source_ids, reason, ..
        } = &assembly.manifest.counterevidence
        else {
            panic!(
                "expected blocked, got {:?}",
                assembly.manifest.counterevidence
            );
        };
        assert_eq!(source_ids, &vec![SOURCE_A.to_string()]);
        assert_eq!(*reason, BlockedCounterevidence::SourceInaccessible);
        assert_eq!(
            assembly.manifest.intents.contradiction.status,
            IntentStatus::Blocked
        );
        // The intents that did not need expansion still ran.
        assert_ne!(
            assembly.manifest.intents.positive.status,
            IntentStatus::Blocked
        );
    }

    #[test]
    fn the_same_question_against_the_same_base_assembles_identically() {
        let first = assembled(&request(shipping(), wide()));
        let second = assembled(&request(shipping(), wide()));
        assert_eq!(first.manifest, second.manifest);
        assert_eq!(first.rendered, second.rendered);
    }

    #[test]
    fn a_moved_ledger_head_is_a_different_assembly() {
        // What makes an `assembly_id` safe to key a runtime row by: the same
        // question against a base that has moved is a different assembly.
        let first = assembled(&request(shipping(), wide()));
        let mut moved = request(shipping(), wide());
        moved.chain_head = "90000000000000000000000000000002";
        let second = assemble(&state(), &corpus(), &Expansion, &moved).unwrap();
        assert_ne!(first.manifest.assembly_id, second.manifest.assembly_id);
        assert_eq!(
            first.manifest.question_hash, second.manifest.question_hash,
            "the question did not change"
        );
    }

    #[test]
    fn a_claim_about_another_slice_is_a_scope_neighbour_and_not_an_answer() {
        let assembly = assembled(&request(shipping(), wide()));
        let planned_item = assertion_item_id(OBS_PLANNED);
        assert!(
            assembly
                .manifest
                .intents
                .scope_neighbor
                .selected_item_ids
                .contains(&planned_item),
            "a planned-stage claim is next door to a shipping question"
        );
        assert!(
            !assembly
                .manifest
                .intents
                .positive
                .selected_item_ids
                .contains(&planned_item),
            "and it is not the answer"
        );
    }

    #[test]
    fn agent_inferred_provenance_is_not_authority() {
        // D11: an agent's inference is a claim, never proof of entitlement.
        let assembly = assembled(&request(shipping(), wide()));
        let authority = &assembly.manifest.intents.authority.selected_item_ids;
        assert!(authority.contains(&assertion_item_id(OBS_AUTHORITY)));
        assert!(
            !authority.contains(&assertion_item_id(OBS_INFERRED)),
            "agent_inferred is in the authority answer only if D11 was ignored"
        );
    }

    #[test]
    fn a_prior_revision_is_historical_and_carries_its_own_event() {
        let assembly = assembled(&request(shipping(), wide()));
        let old = belief_item_id(B_ONE, REV_ONE_OLD);
        assert!(assembly
            .manifest
            .intents
            .historical
            .selected_item_ids
            .contains(&old));
        let item = assembly
            .manifest
            .items
            .iter()
            .find(|item| item.item_id() == old)
            .expect("the old revision is an item");
        let ManifestItem::BeliefRevision {
            belief_revision_event_id,
            ..
        } = item
        else {
            panic!("a belief revision");
        };
        assert_eq!(belief_revision_event_id, REV_ONE_OLD);
    }

    #[test]
    fn a_linked_belief_names_every_source_its_basis_rests_on() {
        // Never one fabricated source for a multi-source belief.
        let assembly = assembled(&request(shipping(), wide()));
        let item = assembly
            .manifest
            .items
            .iter()
            .find(|item| item.item_id() == belief_item_id(B_ONE, REV_ONE))
            .expect("the current revision");
        let ManifestItem::BeliefRevision {
            source_ids,
            basis_observation_event_ids,
            support_state,
            ..
        } = item
        else {
            panic!("a belief revision");
        };
        assert_eq!(*support_state, SupportState::Linked);
        assert_eq!(basis_observation_event_ids.len(), 2);
        assert_eq!(
            source_ids,
            &vec![SOURCE_A.to_string(), SOURCE_B.to_string()]
        );
    }

    #[test]
    fn an_unsupported_belief_names_no_source_and_no_basis() {
        let assembly = assembled(&request(shipping(), wide()));
        let item = assembly
            .manifest
            .items
            .iter()
            .find(|item| item.item_id() == belief_item_id(B_TWO, REV_TWO))
            .expect("the slipped-a-week belief");
        let ManifestItem::BeliefRevision {
            source_ids,
            basis_observation_event_ids,
            support_state,
            ..
        } = item
        else {
            panic!("a belief revision");
        };
        assert_eq!(*support_state, SupportState::Unsupported);
        assert!(source_ids.is_empty() && basis_observation_event_ids.is_empty());
    }

    #[test]
    fn a_question_that_names_nothing_exhausts_every_intent() {
        // And "exhausted" is honest here because every intent recorded the
        // search that found nothing.
        let mut nothing = request(shipping(), wide());
        nothing.question = "a bare heading with no names in it";
        let assembly = assemble(&state(), &corpus(), &Expansion, &nothing).expect("a manifest");
        for intent in Intent::ALL {
            assert_eq!(
                assembly.manifest.intents.get(intent).status,
                IntentStatus::Exhausted,
                "{}",
                intent.as_str()
            );
        }
        assert!(assembly.manifest.items.is_empty());
        assert!(matches!(
            assembly.manifest.counterevidence,
            Counterevidence::Exhausted { .. }
        ));
    }

    #[test]
    fn the_bytes_the_prompt_will_print_are_the_bytes_the_manifest_counted() {
        let assembly = assembled(&request(shipping(), wide()));
        let counted: u64 = assembly
            .rendered
            .values()
            .map(|text| text.len() as u64)
            .sum();
        assert_eq!(assembly.manifest.actual.context_bytes, counted);
        for item in &assembly.manifest.items {
            let text = &assembly.rendered[item.item_id()];
            assert_eq!(item.byte_count(), text.len() as u64);
        }
    }

    #[test]
    fn an_item_two_intents_wanted_is_shown_once_and_named_by_both() {
        let assembly = assembled(&request(shipping(), wide()));
        let both = assembly
            .manifest
            .items
            .iter()
            .find(|item| item.selected_by_intents().len() > 1)
            .expect("the fixture has one");
        let appearances = assembly
            .manifest
            .items
            .iter()
            .filter(|item| item.item_id() == both.item_id())
            .count();
        assert_eq!(appearances, 1, "an item is shown once and counted once");
    }

    #[test]
    fn counterevidence_the_base_cannot_describe_refuses_rather_than_reports_none() {
        // The defect this refusal exists for. If the contradicting belief is
        // skipped because its basis will not resolve, the manifest would say
        // `exhausted` — "we looked and there is no disagreement" — about a
        // disagreement it had just found. A fabricated absence is worse than
        // no answer.
        let mut state = state();
        state.beliefs.get_mut(B_TWO).unwrap().revisions[0].basis =
            linked(&["2f000000000000000000000000000099"]);
        let refusal = assemble(&state, &corpus(), &Expansion, &request(shipping(), wide()))
            .expect_err("no manifest");
        let Refusal::Incoherent { detail } = refusal else {
            panic!("expected incoherent");
        };
        assert!(detail.contains(REV_TWO), "{detail}");
    }

    #[test]
    fn an_assertion_the_ledger_could_not_be_read_for_refuses_too() {
        // Same rule from the other side: the projection holds an assertion
        // whose bytes this assembly could not read, so it can be placed
        // neither in the question's slice nor next door to it.
        let mut state = state();
        let missing = "20000000000000000000000000000009";
        state.observations.insert(
            missing.into(),
            observation(
                missing,
                FALCON,
                SOURCE_A,
                AuthorityProvenance::RegisteredDirectArtifact,
            ),
        );
        let refusal = assemble(&state, &corpus(), &Expansion, &request(shipping(), wide()))
            .expect_err("no manifest");
        assert!(matches!(refusal, Refusal::Incoherent { .. }), "{refusal:?}");
    }

    #[test]
    fn a_claimed_spelling_is_part_of_the_assembly_id() {
        // The defect four independent reviews found. `aliases` resolves to
        // entities in `subjects_of` and is handed to the retriever in
        // `expand`, so the same prose with an extra spelling is a DIFFERENT
        // search — and it used to share an id with the bare one.
        //
        // The failure that made it serious was not the collision itself: it
        // was that a reader fetching the shared id could be handed the search
        // that reported `exhausted` about a disagreement the other one found.
        let state = state();
        let bare = Request {
            question: "is it on track?",
            ..request(shipping(), wide())
        };
        let claimed = ["Falcon".to_string()];
        let expanded = Request {
            question: "is it on track?",
            aliases: &claimed,
            ..request(shipping(), wide())
        };

        let bare = assemble(&state, &corpus(), &Expansion, &bare).unwrap();
        let expanded = assemble(&state, &corpus(), &Expansion, &expanded).unwrap();

        // The premise: the two really are different searches.
        assert!(bare.manifest.items.is_empty(), "the prose names nothing");
        assert!(
            !expanded.manifest.items.is_empty(),
            "the spelling reaches Falcon"
        );
        assert!(matches!(
            bare.manifest.counterevidence,
            Counterevidence::Exhausted { .. }
        ));
        assert!(
            matches!(
                expanded.manifest.counterevidence,
                Counterevidence::Included { .. }
            ),
            "and one of them finds the contradiction the other misses"
        );

        assert_ne!(
            bare.manifest.assembly_id, expanded.manifest.assembly_id,
            "two different searches cannot share a content address"
        );
    }

    #[test]
    fn the_same_spellings_in_a_different_order_are_the_same_assembly() {
        // Normalized, sorted and deduped: an id that moved when a caller
        // reordered its own list would defeat the idempotency the id exists
        // for.
        let state = state();
        let one = ["Falcon".to_string(), "Kestrel".to_string()];
        let other = ["kestrel".to_string(), "FALCON".to_string(), "Falcon".into()];
        let first = assemble(
            &state,
            &corpus(),
            &Expansion,
            &Request {
                aliases: &one,
                ..request(shipping(), wide())
            },
        )
        .unwrap();
        let second = assemble(
            &state,
            &corpus(),
            &Expansion,
            &Request {
                aliases: &other,
                ..request(shipping(), wide())
            },
        )
        .unwrap();
        assert_eq!(first.manifest.assembly_id, second.manifest.assembly_id);
        assert_eq!(first.manifest, second.manifest);
    }

    #[test]
    fn a_retracted_belief_is_not_what_an_assertion_is_supported_at() {
        // `supported_at` says the base ACTED on this assertion, which is the
        // claim a retraction withdraws. The tombstoned belief also sorts
        // FIRST here, so without the guard it wins on hex id order.
        let mut state = state();
        let retracted = "b0000000000000000000000000000000";
        let mut belief = belief(
            retracted,
            FALCON,
            vec![revision(
                1,
                "10000000000000000000000000000009",
                "the cutover was cancelled",
                linked(&[OBS_AUTHORITY]),
            )],
        );
        belief.tombstoned_by = Some("70000000000000000000000000000001".into());
        state.beliefs.insert(retracted.into(), belief);

        let assembly = assemble(&state, &corpus(), &Expansion, &request(shipping(), wide()))
            .expect("a manifest");
        let item = assembly
            .manifest
            .items
            .iter()
            .find(|item| item.item_id() == assertion_item_id(OBS_AUTHORITY))
            .expect("the authoritative assertion");
        let ManifestItem::Assertion { belief_context, .. } = item else {
            panic!("an assertion");
        };
        let BeliefContext::SupportedAt { belief_id, .. } = belief_context else {
            panic!("the live belief still rests on it");
        };
        assert_eq!(
            belief_id, B_ONE,
            "the live belief, not the retracted one that sorts before it"
        );
    }

    #[test]
    fn an_assertion_only_a_retracted_belief_rested_on_has_no_belief_context() {
        let mut state = state();
        // Take the live belief's basis away so the ONLY belief resting on the
        // authoritative assertion is a retracted one.
        state.beliefs.get_mut(B_ONE).unwrap().revisions[1].basis = unsupported();
        let retracted = "b0000000000000000000000000000000";
        let mut belief = belief(
            retracted,
            FALCON,
            vec![revision(
                1,
                "10000000000000000000000000000009",
                "the cutover was cancelled",
                linked(&[OBS_AUTHORITY]),
            )],
        );
        belief.tombstoned_by = Some("70000000000000000000000000000001".into());
        state.beliefs.insert(retracted.into(), belief);

        let assembly = assemble(&state, &corpus(), &Expansion, &request(shipping(), wide()))
            .expect("a manifest");
        let item = assembly
            .manifest
            .items
            .iter()
            .find(|item| item.item_id() == assertion_item_id(OBS_AUTHORITY))
            .expect("the authoritative assertion");
        let ManifestItem::Assertion { belief_context, .. } = item else {
            panic!("an assertion");
        };
        assert_eq!(
            *belief_context,
            BeliefContext::None,
            "nothing the base still holds rests on it"
        );
    }
}
