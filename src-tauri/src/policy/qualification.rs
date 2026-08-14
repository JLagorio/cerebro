//! Qualification gates as capability profiles (M24.6).
//!
//! **Type-name-blind.** The house rule — behaviour is capability-gated, never
//! routed on a type's name — extended to policy. Nothing here knows what a
//! Risk or a Decision is. A type doc annotates its fields with ROLES
//! (`role: owner`, `role: failure_condition`, …), and the gate asks one
//! question: does this item actually carry a value for every role its own
//! type declares? A vault that renames Risk to Threat, or invents a type
//! nobody anticipated, gets the same gate for free.
//!
//! **The required roles are the type doc's, never the caller's.** The
//! proposal carries a `QualificationProfileRef`, but it is a CLAIM about
//! which profile applies, and the server derives the real one from the type
//! doc at the current head and requires the two to agree. Trusting the
//! submitted `required_roles` would let a proposal name a weaker gate than
//! the one that exists — the profile would be decorative, and the ledger
//! event would record a rule nobody applied.
//!
//! **Only promotion is gated.** `qualification_roles_present` appears in
//! exactly one op's `requires` list, and a tripwire keeps it there. A human
//! sketching a rough note, and every create/update path, never touches this
//! module: half-finished thoughts are the normal state of a vault, and a
//! gate on capture would be an app arguing with someone who is thinking.
//!
//! A refusal parks VISIBLY rather than vanishing — see `runtime::parked`.

use std::cell::OnceCell;
use std::collections::BTreeMap;
use std::path::Path;

use crate::ledger::reduce::EpistemicState;
use crate::ledger::schema::{
    FieldRole, ProposalOp, ProposalV1, QualificationProfileRef, TypedValue,
};

use super::preconditions::{PreconditionFailure, PreconditionResult};

/// The frontmatter key a record's type is declared under, and the key a Type
/// doc declares its fields under. Both are the vault format's, not policy's.
const TYPE_KEY: &str = "type";
const FIELDS_KEY: &str = "fields";
/// The field-definition key carrying a role annotation.
const ROLE_KEY: &str = "role";
/// The `type:` value that marks a doc as a type declaration.
const TYPE_DOC: &str = "Type";

/// One type's role assignment, as a profile is judged against.
#[derive(Debug, Clone, PartialEq)]
pub struct TypeSchema {
    /// The type's name — what records carry in `type:`.
    pub type_id: String,
    /// Field name → the raw `role:` annotation, sorted by field name.
    pub annotations: BTreeMap<String, String>,
}

impl TypeSchema {
    /// Read a Type doc's `fields:` block.
    pub fn read(type_id: &str, fields: Option<&serde_json::Value>) -> TypeSchema {
        let annotations = fields
            .and_then(serde_json::Value::as_object)
            .map(|fields| {
                fields
                    .iter()
                    .filter_map(|(name, definition)| {
                        let role = definition.get(ROLE_KEY)?.as_str()?;
                        Some((name.clone(), role.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        TypeSchema {
            type_id: type_id.to_string(),
            annotations,
        }
    }

    /// Annotations naming a role this build does not know.
    ///
    /// Returned rather than dropped: `role: onwer` silently disabling a gate
    /// is the worst outcome available, because the type doc would still LOOK
    /// like it was protecting something.
    pub fn unknown_roles(&self) -> Vec<&str> {
        self.annotations
            .values()
            .filter(|annotation| FieldRole::parse(annotation).is_none())
            .map(String::as_str)
            .collect()
    }

    /// Which fields carry a role, in field-name order.
    fn fields_for(&self, role: FieldRole) -> Vec<&str> {
        self.annotations
            .iter()
            .filter(|(_, annotation)| annotation.as_str() == role.as_str())
            .map(|(name, _)| name.as_str())
            .collect()
    }

    /// Every role this type declares, in canonical order.
    fn declared_roles(&self) -> Vec<FieldRole> {
        let mut roles: Vec<FieldRole> = FieldRole::ALL
            .iter()
            .copied()
            .filter(|role| !self.fields_for(*role).is_empty())
            .collect();
        roles.sort();
        roles
    }

    /// The pin: a digest of the ROLE ASSIGNMENT, not of the whole type doc.
    ///
    /// The pin exists so a type-doc edit cannot retroactively re-decide an
    /// old promotion. What it must therefore cover is which field carries
    /// which role — and nothing else. Hashing the whole doc would make
    /// recolouring a status option invalidate every promotion in flight, and
    /// a gate that cries stale for cosmetic edits is one people learn to
    /// route around.
    pub fn schema_hash(&self) -> String {
        let body = serde_json::to_string(&self.annotations).unwrap_or_default();
        let mut bytes = Vec::with_capacity(body.len() + 40);
        bytes.extend_from_slice(b"cerebro-qualification-profile-v1\0");
        bytes.extend_from_slice(self.type_id.as_bytes());
        bytes.push(0);
        bytes.extend_from_slice(body.as_bytes());
        crate::ledger::sha256_hex(&bytes)
    }

    /// The profile the server will judge against, or None when this type
    /// declares no roles at all.
    ///
    /// None is not "everything passes": a profile requiring no roles is a
    /// gate that never gates, which the schema already refuses. It means
    /// promotion is not a thing this type supports yet.
    pub fn profile(&self) -> Option<QualificationProfileRef> {
        let required_roles = self.declared_roles();
        if required_roles.is_empty() {
            return None;
        }
        Some(QualificationProfileRef {
            type_id: self.type_id.clone(),
            type_schema_hash: self.schema_hash(),
            required_roles,
        })
    }

    /// Which required roles have no filled field on this item.
    ///
    /// A role is satisfied by ANY of its fields — a type may annotate two
    /// evidence fields, and filling either one is evidence.
    pub fn missing_roles(&self, fields: &serde_json::Value) -> Vec<FieldRole> {
        self.declared_roles()
            .into_iter()
            .filter(|role| {
                !self
                    .fields_for(*role)
                    .iter()
                    .any(|name| is_filled(fields.get(name)))
            })
            .collect()
    }
}

/// Is this frontmatter value actually there?
///
/// Blank strings and empty lists are the shape of a field a template created
/// and nobody filled in — treating them as present would make the gate pass
/// on exactly the items it exists to catch.
fn is_filled(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::String(text)) => !text.trim().is_empty(),
        Some(serde_json::Value::Array(items)) => !items.is_empty(),
        Some(serde_json::Value::Object(map)) => !map.is_empty(),
        Some(_) => true,
    }
}

/// The vault's type docs, read at most once per commit.
///
/// Lazy because most commit sets contain no promotion at all, and a vault
/// scan for every one of them would be a cost paid by everything to serve
/// the one op that needs it.
pub struct Catalog<'a> {
    vault: &'a Path,
    store_id: String,
    types: OnceCell<BTreeMap<String, TypeSchema>>,
}

impl<'a> Catalog<'a> {
    pub fn new(vault: &'a Path, store_id: &str) -> Catalog<'a> {
        Catalog {
            vault,
            store_id: store_id.to_string(),
            types: OnceCell::new(),
        }
    }

    /// A catalog over types given directly — the test and fixture path, and
    /// the reason nothing here needs a vault on disk to be exercised.
    #[cfg(test)]
    pub fn of(store_id: &str, types: Vec<TypeSchema>) -> Catalog<'static> {
        let cell = OnceCell::new();
        let _ = cell.set(
            types
                .into_iter()
                .map(|schema| (schema.type_id.clone(), schema))
                .collect(),
        );
        Catalog {
            vault: Path::new(""),
            store_id: store_id.to_string(),
            types: cell,
        }
    }

    pub fn store_id(&self) -> &str {
        &self.store_id
    }

    /// Fails CLOSED: a vault we cannot scan yields no types, and a promotion
    /// against a type nobody can read is refused rather than waved through.
    fn types(&self) -> &BTreeMap<String, TypeSchema> {
        self.types.get_or_init(|| match read_types(self.vault) {
            Ok(types) => types,
            Err(e) => {
                eprintln!("qualification: could not read type docs: {e}");
                BTreeMap::new()
            }
        })
    }

    pub fn type_named(&self, type_id: &str) -> Option<&TypeSchema> {
        self.types().get(type_id)
    }
}

/// Every `type: Type` doc in the vault, by the name it declares.
///
/// Identified by its own `type:` value rather than by living in `types/`,
/// because that is what the app itself does — the metamodel is the one name
/// the app must know (`typeCatalog.ts`), and a second convention here would
/// disagree with the sidebar the moment someone moved a file.
pub fn read_types(vault: &Path) -> Result<BTreeMap<String, TypeSchema>, String> {
    let entries = crate::vault::scan::scan_vault(vault)?;
    Ok(entries
        .iter()
        .filter(|entry| entry.entry_type.as_deref() == Some(TYPE_DOC))
        .map(|entry| {
            let schema = TypeSchema::read(&entry.title, entry.properties.get(FIELDS_KEY));
            (entry.title.clone(), schema)
        })
        .collect())
}

fn failure(
    code: &'static str,
    expected: TypedValue,
    actual: TypedValue,
) -> Box<PreconditionFailure> {
    Box::new(PreconditionFailure {
        code,
        rule: "qualification_roles_present",
        expected,
        actual,
    })
}

fn roles_value(roles: &[FieldRole]) -> TypedValue {
    TypedValue::string(
        &roles
            .iter()
            .map(|role| role.as_str())
            .collect::<Vec<_>>()
            .join(","),
    )
}

/// The predicate: does this item carry every role its type requires?
///
/// Ordered so the message is always about the nearest thing that is wrong:
/// what type is this, is that type readable, is the pinned profile still the
/// real one, and only then which fields are empty.
pub fn roles_present(
    catalog: &Catalog,
    state: &EpistemicState,
    proposal: &ProposalV1,
) -> PreconditionResult {
    let ProposalOp::PromoteDraft {
        belief_id,
        qualification_profile,
    } = &proposal.op
    else {
        return Ok(());
    };

    let Some(belief) = state.beliefs.get(belief_id) else {
        return Err(failure(
            "invalid_reference",
            TypedValue::string("a committed belief"),
            TypedValue::string(belief_id),
        ));
    };
    let Some(revision) = belief.revisions.last() else {
        return Err(failure(
            "invalid_reference",
            TypedValue::string("a belief with a revision"),
            TypedValue::string(belief_id),
        ));
    };

    // The item's own declaration decides which profile applies. An item with
    // no type has no roles to be missing — and no profile could honestly
    // name one.
    let Some(declared_type) = revision.fields.get(TYPE_KEY).and_then(|v| v.as_str()) else {
        return Err(failure(
            "invalid_reference",
            TypedValue::string("a target declaring a type"),
            TypedValue::Missing,
        ));
    };
    let Some(schema) = catalog.type_named(declared_type) else {
        return Err(failure(
            "invalid_reference",
            TypedValue::string("a type doc declaring this type"),
            TypedValue::string(declared_type),
        ));
    };
    if let [unknown, ..] = schema.unknown_roles().as_slice() {
        // A typo in an annotation is refused loudly rather than treated as
        // "no role here": the doc still looks like it is protecting
        // something, and quietly agreeing would make that appearance true
        // enough to trust.
        return Err(failure(
            "invalid_reference",
            TypedValue::string("a known field role"),
            TypedValue::string(unknown),
        ));
    }

    let Some(derived) = schema.profile() else {
        return Err(failure(
            "policy_precondition_stale",
            TypedValue::string("a type declaring at least one field role"),
            TypedValue::string(declared_type),
        ));
    };
    if *qualification_profile != derived {
        // The pinned profile is a claim; this is where it stops being taken
        // on trust. Either the type doc moved under a queued card, or the
        // proposal named a gate weaker than the real one.
        return Err(failure(
            "policy_precondition_stale",
            roles_value(&derived.required_roles),
            roles_value(&qualification_profile.required_roles),
        ));
    }

    let missing = schema.missing_roles(&revision.fields);
    if !missing.is_empty() {
        // PARK VISIBLY. The refusal is already decided; this is the trace
        // that turns "no" into a worklist, and it must not be able to change
        // what the caller is told.
        crate::runtime::sink::park(&crate::runtime::parked::Parked {
            store_id: catalog.store_id().to_string(),
            belief_id: belief_id.clone(),
            record_path: belief.path.clone(),
            type_id: derived.type_id.clone(),
            type_schema_hash: derived.type_schema_hash.clone(),
            missing_roles: missing.clone(),
        });
        return Err(failure(
            "qualification_missing",
            roles_value(&derived.required_roles),
            roles_value(&missing),
        ));
    }

    crate::runtime::sink::clear_park(catalog.store_id(), belief_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::reduce::{BeliefState, RevisionState};
    use crate::ledger::schema::{BeliefBasis, Qualification, TargetClass};
    use crate::policy::fixtures::{proposal, target};
    use crate::policy::table::{PolicyTable, Risk};

    const BELIEF: &str = "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1";
    const ENTITY: &str = "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2";
    const STORE: &str = "store-a";

    /// A type doc declaring an owner field and a "what would falsify this"
    /// field — deliberately named nothing a policy rule could pattern-match.
    fn metric() -> TypeSchema {
        TypeSchema::read(
            "Metric",
            Some(&serde_json::json!({
                "status": { "kind": "status" },
                "steward": { "kind": "relation", "role": "owner" },
                "breaks_when": { "kind": "text", "role": "failure_condition" },
            })),
        )
    }

    fn belief_with(fields: serde_json::Value) -> BeliefState {
        BeliefState {
            belief_id: BELIEF.into(),
            entity_id: ENTITY.into(),
            created_event_id: ENTITY.into(),
            revisions: vec![RevisionState {
                event_id: ENTITY.into(),
                revision: 1,
                content: String::new(),
                fields,
                basis: BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
            }],
            attested: None,
            attestation_events: vec![],
            path: Some("knowledge/pick-a-metric.md".into()),
            overrides: vec![],
            override_head_event: None,
            projection_head_event: ENTITY.into(),
            qualification: Qualification::Draft,
            lifecycle: crate::ledger::schema::Lifecycle::Active,
            tombstoned_by: None,
            open_contest_event: None,
            qualification_head_event: None,
            lifecycle_head_event: None,
            contest_head_event: None,
            entity_merge_event_ids: vec![],
        }
    }

    fn world(fields: serde_json::Value) -> EpistemicState {
        let mut state = EpistemicState::default();
        state
            .beliefs
            .insert(BELIEF.to_string(), belief_with(fields));
        state
    }

    fn promotion(profile: QualificationProfileRef) -> ProposalV1 {
        proposal(
            BELIEF,
            ENTITY,
            ProposalOp::PromoteDraft {
                belief_id: BELIEF.into(),
                qualification_profile: profile,
            },
            vec![target(TargetClass::Belief, BELIEF, Some(1))],
            Risk::Medium,
        )
    }

    #[test]
    fn a_promotion_passes_when_every_declared_role_is_filled() {
        let catalog = Catalog::of(STORE, vec![metric()]);
        let state = world(serde_json::json!({
            "type": "Metric",
            "steward": "[[Ada]]",
            "breaks_when": "the pipeline stops emitting",
        }));
        assert!(roles_present(&catalog, &state, &promotion(metric().profile().unwrap())).is_ok());
    }

    #[test]
    fn an_empty_field_is_missing_and_a_blank_string_is_too() {
        // A template created the key and nobody filled it in — which is the
        // exact item this gate exists to catch.
        let catalog = Catalog::of(STORE, vec![metric()]);
        let state = world(serde_json::json!({
            "type": "Metric",
            "steward": "   ",
            "breaks_when": null,
        }));
        let failure =
            roles_present(&catalog, &state, &promotion(metric().profile().unwrap())).unwrap_err();
        assert_eq!(failure.code, "qualification_missing");
        assert_eq!(failure.rule, "qualification_roles_present");
        assert_eq!(
            failure.expected,
            TypedValue::string("failure_condition,owner")
        );
        assert_eq!(
            failure.actual,
            TypedValue::string("failure_condition,owner")
        );
    }

    #[test]
    fn one_of_a_roles_two_fields_is_enough() {
        let schema = TypeSchema::read(
            "Claim",
            Some(&serde_json::json!({
                "citation": { "kind": "text", "role": "evidence" },
                "attachment": { "kind": "files", "role": "evidence" },
            })),
        );
        let state = world(serde_json::json!({ "type": "Claim", "attachment": ["a.pdf"] }));
        let catalog = Catalog::of(STORE, vec![schema.clone()]);
        assert!(roles_present(&catalog, &state, &promotion(schema.profile().unwrap())).is_ok());
    }

    #[test]
    fn the_gate_reads_the_type_docs_roles_not_the_proposals_claim() {
        // THE POINT. A proposal naming a weaker profile than the one that
        // exists would make the pin decorative and let an agent grade its
        // own homework.
        let catalog = Catalog::of(STORE, vec![metric()]);
        let state = world(serde_json::json!({ "type": "Metric", "steward": "[[Ada]]" }));
        let mut understated = metric().profile().unwrap();
        understated.required_roles = vec![FieldRole::Owner];
        understated.type_schema_hash = metric().schema_hash();

        let failure = roles_present(&catalog, &state, &promotion(understated)).unwrap_err();
        assert_eq!(failure.code, "policy_precondition_stale");
        assert_eq!(
            failure.expected,
            TypedValue::string("failure_condition,owner")
        );
        assert_eq!(failure.actual, TypedValue::string("owner"));
    }

    #[test]
    fn a_type_doc_edited_after_the_card_was_written_is_stale_not_applied() {
        let catalog = Catalog::of(STORE, vec![metric()]);
        let state = world(serde_json::json!({
            "type": "Metric",
            "steward": "[[Ada]]",
            "breaks_when": "x",
        }));
        let mut stale = metric().profile().unwrap();
        stale.type_schema_hash = "0".repeat(64);
        assert_eq!(
            roles_present(&catalog, &state, &promotion(stale))
                .unwrap_err()
                .code,
            "policy_precondition_stale"
        );
    }

    #[test]
    fn a_type_nobody_declares_refuses_rather_than_waving_through() {
        // Fails closed: an unreadable or absent type doc means the gate
        // cannot know what is required, which is not the same as nothing
        // being required.
        let catalog = Catalog::of(STORE, vec![]);
        let state = world(serde_json::json!({ "type": "Metric" }));
        let failure =
            roles_present(&catalog, &state, &promotion(metric().profile().unwrap())).unwrap_err();
        assert_eq!(failure.code, "invalid_reference");
        assert_eq!(failure.actual, TypedValue::string("Metric"));
    }

    #[test]
    fn a_misspelled_role_annotation_is_refused_not_ignored() {
        // `role: onwer` silently disabling a gate is the worst outcome
        // available: the doc still looks like it protects something.
        let typo = TypeSchema::read(
            "Metric",
            Some(&serde_json::json!({ "steward": { "kind": "text", "role": "onwer" } })),
        );
        let catalog = Catalog::of(STORE, vec![typo]);
        let state = world(serde_json::json!({ "type": "Metric", "steward": "[[Ada]]" }));
        let failure =
            roles_present(&catalog, &state, &promotion(metric().profile().unwrap())).unwrap_err();
        assert_eq!(failure.code, "invalid_reference");
        assert_eq!(failure.actual, TypedValue::string("onwer"));
    }

    #[test]
    fn a_type_with_no_role_annotations_declares_no_profile() {
        let plain = TypeSchema::read(
            "Note",
            Some(&serde_json::json!({ "status": { "kind": "status" } })),
        );
        assert_eq!(plain.profile(), None);
        assert!(plain.missing_roles(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn the_pin_covers_the_role_assignment_and_not_the_types_colours() {
        // A recoloured status option must not invalidate every promotion in
        // flight; a moved role must.
        let recoloured = TypeSchema::read(
            "Metric",
            Some(&serde_json::json!({
                "status": { "kind": "status", "color": "#FF0000" },
                "steward": { "kind": "relation", "role": "owner" },
                "breaks_when": { "kind": "text", "role": "failure_condition" },
            })),
        );
        assert_eq!(recoloured.schema_hash(), metric().schema_hash());

        let moved = TypeSchema::read(
            "Metric",
            Some(&serde_json::json!({
                "status": { "kind": "status" },
                "keeper": { "kind": "relation", "role": "owner" },
                "breaks_when": { "kind": "text", "role": "failure_condition" },
            })),
        );
        assert_ne!(moved.schema_hash(), metric().schema_hash());

        // ...and two types with the same roles are still two profiles.
        let elsewhere = TypeSchema {
            type_id: "Signal".into(),
            annotations: metric().annotations,
        };
        assert_ne!(elsewhere.schema_hash(), metric().schema_hash());
    }

    #[test]
    fn a_derived_profile_satisfies_the_schema_it_will_be_written_as() {
        // The derived profile is what lands in `belief.qualification_changed`
        // — canonical role order and all.
        assert!(metric().profile().unwrap().validate().is_ok());
    }

    #[test]
    fn nothing_but_a_promotion_reaches_this_gate() {
        // Capability-gated: the predicate is a no-op for every other op even
        // if the table ever named it, so an update can never be refused for
        // an empty owner field.
        let catalog = Catalog::of(STORE, vec![]);
        let update = proposal(
            BELIEF,
            ENTITY,
            ProposalOp::UpdateBelief {
                belief_id: BELIEF.into(),
                patch: vec![],
                basis: BeliefBasis::Unsupported {
                    reason: "fixture".into(),
                },
            },
            vec![target(TargetClass::Belief, BELIEF, Some(1))],
            Risk::Medium,
        );
        assert!(roles_present(&catalog, &world(serde_json::json!({})), &update).is_ok());
    }

    #[test]
    fn only_promotion_requires_the_gate_in_the_table() {
        // THE TRIPWIRE THAT KEEPS CAPTURE FREE. A human sketching a rough
        // note must never meet a qualification gate; the way that stays true
        // is that no other op requires the predicate.
        let table = PolicyTable::load().unwrap();
        let gated: Vec<&str> = table
            .ops
            .iter()
            .filter(|(_, rule)| {
                rule.requires
                    .iter()
                    .any(|p| p == "qualification_roles_present")
            })
            .map(|(kind, _)| kind.as_str())
            .collect();
        assert_eq!(gated, vec!["promote_draft"]);
    }

    #[test]
    fn every_code_this_gate_names_is_one_promote_draft_declares() {
        let table = PolicyTable::load().unwrap();
        let rule = table.op("promote_draft").unwrap();
        for code in [
            "invalid_reference",
            "policy_precondition_stale",
            "qualification_missing",
        ] {
            assert!(
                rule.possible_rejections.iter().any(|r| r == code),
                "{code} is refused by the gate and not declared by the op"
            );
        }
    }
}
