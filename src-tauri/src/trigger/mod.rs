//! The trigger registry (M28.0) — deferral governance as data.
//!
//! **This module authorizes nothing.** M28+ defers fourteen capabilities, each
//! behind a named gate; what ships here is only the substrate that can
//! EVALUATE and RECORD those gates: the closed registry artifact and its
//! loader. A `fired` result permits exactly one thing — a dated plan document
//! plus a matrix-row update in one commit — and never the deferred
//! capability's code, a feature flag, an agent launch, or a proposal
//! registration.
//!
//! **The registry is closed, and closed as data.** Which gate key requires
//! which evaluation variant, which parents a subcapability may name, and which
//! unit a metric carries all live in
//! `shared/policy/trigger-registry.v1.json`, read by this module and by
//! `src/lib/trigger/registry.ts` from the same bytes. Any combination the
//! artifact does not name refuses — there is no default variant and no
//! benefit of the doubt, because a gate that can be evaluated under the wrong
//! rules is a gate somebody can satisfy by accident.

pub mod cost;
pub mod evaluate;
pub mod evaluation;
pub mod evidence;
pub mod observations;
pub mod registry;
pub mod runner;
pub mod sources;

#[cfg(test)]
mod tests {
    //! The M28.0 tripwires: every R1–R14 capability remains DISABLED, and no
    //! code takes a protected name. Neither is an assertion about this
    //! module's good intentions — both scan sources, so the failure arrives
    //! with the commit that violates them, not in review.

    use std::path::{Path, PathBuf};

    /// The whole trigger module, non-test halves, as bytes to scan.
    const TRIGGER_SOURCES: [(&str, &str); 8] = [
        ("mod.rs", include_str!("mod.rs")),
        ("registry.rs", include_str!("registry.rs")),
        ("evaluation.rs", include_str!("evaluation.rs")),
        ("evaluate.rs", include_str!("evaluate.rs")),
        ("cost.rs", include_str!("cost.rs")),
        ("sources.rs", include_str!("sources.rs")),
        ("evidence.rs", include_str!("evidence.rs")),
        ("runner.rs", include_str!("runner.rs")),
    ];

    #[test]
    fn the_registry_cannot_reach_any_capability_surface() {
        // The evaluator may read the named primitives and write the two
        // governance tables THROUGH runtime::triggers — nothing else. A
        // ledger writer, an agent spawn, an MCP tool, a proposal op, a
        // feature flag, or a raw SQL mutation appearing anywhere in this
        // module is R1–R14 being enabled by the thing that exists to defer
        // them. The registry has no "enabled" field ANYWHERE, and that is
        // the design: a fired result permits a dated plan, never code.
        for (name, source) in TRIGGER_SOURCES {
            let body = source
                .split("#[cfg(test)]")
                .next()
                .expect("the non-test half");
            for forbidden in [
                "LedgerWriter",
                "append_batch",
                "append_once",
                "write_frame",
                "INSERT INTO",
                "UPDATE ",
                "DELETE FROM",
                "mcp::",
                "crate::agent",
                "Command::new",
                ".spawn(",
                "propose_",
                "AppConfig",
                "set_ambient",
                "guard_agent_write",
            ] {
                assert!(
                    !body.contains(forbidden),
                    "{name} reaches {forbidden:?} — the trigger registry authorizes nothing"
                );
            }
        }
        // The one module that DOES hold the INSERTs writes only the two
        // governance tables.
        let store = include_str!("../runtime/triggers.rs");
        for (index, _) in store.match_indices("INSERT INTO") {
            let rest = &store[index + "INSERT INTO".len()..];
            assert!(
                rest.trim_start().starts_with("trigger_"),
                "runtime::triggers inserts into a table that is not governance"
            );
        }
    }

    fn declared_identifiers(source: &str) -> Vec<String> {
        // Type and module declarations, both languages: the identifier after
        // the keyword, exactly. `DiscoveryPlan` is not `Discovery`, and
        // `ClaimedKey` is not `Claim` — the M26 primitives keep their names.
        let mut out = Vec::new();
        for line in source.lines() {
            for keyword in ["struct ", "enum ", "trait ", "mod ", "class ", "interface "] {
                for (index, _) in line.match_indices(keyword) {
                    let rest = &line[index + keyword.len()..];
                    let identifier: String = rest
                        .chars()
                        .take_while(|c| c.is_alphanumeric() || *c == '_')
                        .collect();
                    if !identifier.is_empty() {
                        out.push(identifier);
                    }
                }
            }
        }
        out
    }

    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path
                .extension()
                .is_some_and(|e| e == "rs" || e == "ts" || e == "tsx")
            {
                out.push(path);
            }
        }
    }

    #[test]
    fn no_code_takes_a_protected_name_before_meeting_its_definition() {
        // D6, as a scan: Skeptic, Scout, Curiosity, Claim, Discovery,
        // Forecast, Narrative — the names come off the ARTIFACT, so amending
        // the glossary amends the tripwire. Misnaming silently satisfies
        // triggers that have not been met, which is why this is a build
        // failure and not a review note.
        let registry = crate::trigger::registry::load().unwrap();
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = Vec::new();
        walk(&manifest.join("src"), &mut files);
        walk(&manifest.join("../src"), &mut files);
        assert!(files.len() > 100, "the scan is walking the real tree");
        for file in files {
            let Ok(source) = std::fs::read_to_string(&file) else {
                continue;
            };
            for identifier in declared_identifiers(&source) {
                for name in &registry.protected_names {
                    let lower = name.to_lowercase();
                    assert!(
                        identifier != *name && identifier != lower,
                        "{} declares {identifier:?}, which takes the protected name {name:?} \
                         before meeting its definition",
                        file.display()
                    );
                }
            }
        }
    }
}
