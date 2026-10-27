use super::*;
use crate::{search, source_location::{self, ResolveSourceResult, SourceLocator, SourceScope, SourceSnapshot}, vault::corpus::{CorpusCache, SEARCH_BODY_CAP}};

fn paired_body(f: &Fixture, raw: &str) {
    fs::write(f.root.join("page.md"), raw.as_bytes()).unwrap();
    f.conn().execute("UPDATE records SET body_hash=?1,revision=revision+1 WHERE id=?2", rusqlite::params![crate::ledger::sha256_hex(raw.as_bytes()), RECORD]).unwrap();
    f.conn().execute("UPDATE workspace SET metadata_epoch=metadata_epoch+1", []).unwrap();
}
fn properties(f: &Fixture, value: &Value) {
    f.conn().execute("UPDATE records SET metadata=?1,revision=revision+1 WHERE id=?2", rusqlite::params![value.to_string(), RECORD]).unwrap();
    f.conn().execute("UPDATE workspace SET metadata_epoch=metadata_epoch+1", []).unwrap();
}
fn exact_locator(f: &Fixture, raw: &str, quote: &str) -> SourceLocator {
    let start = raw.find(quote).unwrap();
    source_location::locate_window(&crate::runtime::scope::derive_vault_id(&f.root), "page.md", &SourceSnapshot {
        raw_sha256: crate::ledger::sha256_hex(raw.as_bytes()), carrier: "markdown", body_start_utf8: 0,
        searched_body_bytes: raw.len().min(SEARCH_BODY_CAP), capped: raw.len() > SEARCH_BODY_CAP,
    }, raw, start..start + quote.len(), None).unwrap()
}
fn resolve(f: &Fixture, locator: &SourceLocator) -> ResolveSourceResult {
    source_location::resolve_source(&SourceScope { vault: &f.root, vault_id: &crate::runtime::scope::derive_vault_id(&f.root), admits: &|_| true }, locator).unwrap()
}
#[test]
fn actual_selected_search_emits_body_locator_over_complete_bom_crlf_yaml_bytes() {
    let f = Fixture::new("search-exact-body");
    f.run(|| {
        let found = search::vault_search_in(&CorpusCache::new(1), &f.root, "write_note", 10).unwrap();
        assert_eq!(found.total, 1);
        let locator = found.hits[0].location.as_ref().expect("actual selected body hit has an exact byte locator");
        assert_eq!(locator.kind, "body");
        assert_eq!(locator.source_hash, crate::ledger::sha256_hex(BODY.as_bytes()));
        let range = locator.body_utf8_range.as_ref().unwrap();
        assert_eq!(&BODY[range.start as usize..range.end as usize], locator.quote);
        assert!(locator.quote.contains("write_note"));
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BODY.as_bytes());
    });
}
#[test]
fn actual_selected_source_resolution_never_splits_yaml_looking_body() {
    let f = Fixture::new("source-exact-body");
    f.run(|| {
        let locator = exact_locator(&f, BODY, "type: Agent");
        assert!(matches!(resolve(&f, &locator), ResolveSourceResult::Exact { locator: actual } if actual == locator));
    });
}
#[test]
fn selected_property_locator_refuses_instead_of_opening_body_yaml_as_metadata() {
    let f = Fixture::new("source-no-property-fallback");
    f.run(|| {
        let mut locator = exact_locator(&f, BODY, "write_note");
        locator.kind = "property".into(); locator.property_key = Some("tools".into()); locator.body_utf8_range = None;
        assert!(matches!(resolve(&f, &locator), ResolveSourceResult::Unsupported { .. }));
    });
}
#[test]
fn actual_selected_search_ignores_unrelated_legacy_projection_limits_and_preserves_tagged_metadata() {
    let f = Fixture::new("search-tagged-metadata");
    f.run(|| {
        let mut canonical = f.stored();
        canonical["value"]["precise"] = json!({"kind":"decimal","value":"90071992547409931234567890.001"});
        canonical["value"]["relation"] = json!({"kind":"relation","spelling":"[[Canonical relationalneedle]]","fragment":null,"resolution":{"status":"resolved","targetId":RECORD}});
        properties(&f, &canonical); let before = f.version();
        let cache = CorpusCache::new(1);
        let ordinary=cache.snapshot(&f.root).unwrap();
        let entry=ordinary.entries.iter().find(|entry|entry.path=="page.md").unwrap();
        let wire=serde_json::to_value(entry).unwrap();
        assert_eq!(wire["canonicalProperties"]["value"],canonical);
        let unavailable=wire["canonicalProperties"]["unavailableLegacyKeys"].as_array().unwrap();
        for key in ["precise","relation"]{assert!(unavailable.iter().any(|value|value.as_str()==Some(key)));}
        let tagged=super::super::value::decode_tagged(&canonical.to_string()).unwrap();
        assert!(super::super::value::legacy_value(&tagged).is_err(),"the exact legacy codec remains unsupported");
        let found = search::vault_search_in(&cache, &f.root, "body-link", 10).unwrap();
        assert_eq!(found.total, 1); assert!(found.hits[0].location.is_some());
        assert_eq!(f.stored(), canonical); assert_eq!(f.version(), before);
    });
}
#[test]
fn actual_selected_search_flattens_exact_decimal_and_relation_spelling_without_metadata_source_locations() {
    let f = Fixture::new("search-exact-property-text");
    f.run(|| {
        let mut canonical = f.stored();
        canonical["value"]["precise"] = json!({"kind":"decimal","value":"1e400"});
        canonical["value"]["relation"] = json!({"kind":"relation","spelling":"[[Canonical relationalneedle]]","fragment":null,"resolution":{"status":"unresolved"}});
        properties(&f, &canonical);
        let cache = CorpusCache::new(1);
        for term in ["1e400", "relationalneedle"] {
            let found = search::vault_search_in(&cache, &f.root, term, 10).unwrap();
            assert_eq!(found.total, 1, "canonical property remains searchable: {term}");
            assert!(found.hits[0].location.is_none(), "canonical metadata has no YAML byte locator");
            assert!(found.hits[0].parts.iter().any(|part| part.text.contains(term)));
        }
        assert_eq!(f.stored(), canonical);
    });
}
#[test]
fn selected_search_revalidates_independent_metadata_change_with_identical_body_hash() {
    let f = Fixture::new("search-fresh-metadata");
    f.run(|| {
        let mut canonical = f.stored(); canonical["value"]["grant"] = json!({"kind":"string","value":"oldmetaneedle"}); properties(&f, &canonical);
        let cache = CorpusCache::new(1);
        assert_eq!(search::vault_search_in(&cache, &f.root, "oldmetaneedle", 10).unwrap().total, 1);
        let before = f.version(); canonical["value"]["grant"] = json!({"kind":"string","value":"newmetaneedle"}); properties(&f, &canonical);
        assert_eq!(f.version().body_hash, before.body_hash);
        assert_eq!(search::vault_search_in(&cache, &f.root, "newmetaneedle", 10).unwrap().total, 1);
        assert_eq!(search::vault_search_in(&cache, &f.root, "oldmetaneedle", 10).unwrap().total, 0);
    });
}
#[test]
fn selected_body_locator_stays_exact_after_metadata_only_change() {
    let f = Fixture::new("source-independent-metadata");
    f.run(|| {
        let raw = "# Stable body\nOriginal quote.\n"; paired_body(&f, raw);
        let locator = exact_locator(&f, raw, "Original quote."); let body_hash = f.version().body_hash;
        let mut canonical = f.stored(); canonical["value"]["grant"] = json!({"kind":"string","value":"changed metadata"}); properties(&f, &canonical);
        assert_eq!(f.version().body_hash, body_hash);
        assert!(matches!(resolve(&f, &locator), ResolveSourceResult::Exact { .. }));
    });
}
#[test]
fn selected_body_relocation_uses_complete_new_body_byte_offsets_with_unchanged_metadata() {
    let f = Fixture::new("source-independent-body");
    f.run(|| {
        let original = BODY.replace("A [[body-link]]", &format!("{} A [[body-link]]", "x".repeat(120))); paired_body(&f, &original);
        let locator = exact_locator(&f, &original, "[[body-link]]"); let before = f.version().metadata_hash;
        let after = original.replace("# Canonical body", "# Canonical body\r\nA new paragraph before retained context."); paired_body(&f, &after);
        assert_eq!(f.version().metadata_hash, before);
        let ResolveSourceResult::Relocated { locator: current, previous_hash } = resolve(&f, &locator) else { panic!("paired body passage was not relocated"); };
        assert_eq!(previous_hash, locator.source_hash); assert_eq!(current.source_hash, crate::ledger::sha256_hex(after.as_bytes()));
        let range = current.body_utf8_range.unwrap(); assert_eq!(&after[range.start as usize..range.end as usize], "[[body-link]]");
    });
}
#[test]
fn selected_source_refuses_unpaired_visible_body_even_when_locator_matches_its_file_hash() {
    let f = Fixture::new("source-unpaired-refusal");
    f.run(|| {
        let raw = "# Unpaired visible bytes\nUnpaired quote.\n"; fs::write(f.root.join("page.md"), raw).unwrap();
        let locator = exact_locator(&f, raw, "Unpaired quote.");
        assert!(matches!(resolve(&f, &locator), ResolveSourceResult::Unavailable { .. }));
        assert!(search::vault_search_in(&CorpusCache::new(1), &f.root, "Unpaired quote", 10).is_err());
    });
}
#[test]
fn selected_source_scope_refuses_before_any_canonical_metadata_read() {
    let f = Fixture::new("source-scope-control");
    f.run(|| {
        let locator = exact_locator(&f, BODY, "Canonical body"); fs::rename(&f.db, f.db.with_extension("unavailable")).unwrap();
        let result = source_location::resolve_source(&SourceScope { vault: &f.root, vault_id: &locator.vault_id, admits: &|_| false }, &locator).unwrap();
        assert!(matches!(result, ResolveSourceResult::Unavailable { .. }));
    });
}
#[test]
fn selected_search_uses_actual_ranker_scope_before_returning_metadata_or_body_matches() {
    let f = Fixture::new("search-readable-scope");
    f.run(|| {
        let secret = "# Hidden page\nscopesecretneedle\n"; testutil::write(&f.root, "secret.md", secret);
        f.conn().execute("INSERT INTO records VALUES (?1,'secret.md',1,?2,?3)", rusqlite::params!["2a22406a-07d5-44d8-bc24-b67e61070bea", crate::ledger::sha256_hex(secret.as_bytes()), metadata().to_string()]).unwrap();
        let corpus = CorpusCache::new(1).search_snapshot(&f.root).unwrap();
        let kept = search::docs_of(&corpus, |entry| entry.path == "page.md");
        assert_eq!(search::rank("scopesecretneedle", &kept.docs(), 10).total, 0);
        let all = search::docs_of(&corpus, |_| true);
        assert_eq!(search::rank("scopesecretneedle", &all.docs(), 10).total, 1);
    });
}
#[test]
fn selected_search_caps_visible_bytes_but_locates_against_complete_file_hash() {
    let f = Fixture::new("search-capped-body");
    f.run(|| {
        let raw = format!("# Capped body\nheadneedle\n{}tailneedle", "x ".repeat(SEARCH_BODY_CAP)); paired_body(&f, &raw);
        let cache = CorpusCache::new(1);
        let tail = search::vault_search_in(&cache, &f.root, "tailneedle", 10).unwrap(); assert_eq!(tail.total, 0); assert_eq!(tail.capped, 1);
        let head = search::vault_search_in(&cache, &f.root, "headneedle", 10).unwrap(); assert_eq!(head.total, 1); assert_eq!(head.capped, 1);
        let locator = head.hits[0].location.as_ref().expect("searched head retains source evidence");
        assert_eq!(locator.source_hash, crate::ledger::sha256_hex(raw.as_bytes()));
        assert!(locator.body_utf8_range.as_ref().unwrap().end as usize <= SEARCH_BODY_CAP);
    });
}

#[test]
fn selected_search_keeps_existing_agent_private_field_rules_on_canonical_metadata() {
    let f = Fixture::new("search-agent-privacy");
    f.run(|| {
        let mut canonical = f.stored(); canonical["value"]["type"] = json!({"kind":"string","value":"Agent"});
        for key in ["recent", "memory", "preferences", "_private"] { canonical["value"][key] = json!({"kind":"string","value":"neverprivateneedle"}); }
        properties(&f, &canonical);
        let found = search::vault_search_in(&CorpusCache::new(1), &f.root, "neverprivateneedle", 10).unwrap();
        assert_eq!(found.total, 0); assert_eq!(f.stored(), canonical);
    });
}

#[test]
fn actual_legacy_source_resolver_refuses_nested_selected_landing_before_yaml_interpretation() {
    let f = Fixture::new("source-nested-selected-landing");
    f.run(|| {
        let legacy_root = f.root.parent().unwrap();
        assert!(matches!(authority::resolve(legacy_root).unwrap(), authority::Authority::Legacy));
        let path = format!("{}/page.md", f.root.file_name().unwrap().to_str().unwrap());
        let legacy_body = vault::parse::split_frontmatter(BODY).1;
        let start = legacy_body.find("Canonical body").unwrap();
        let locator = source_location::locate_window(&crate::runtime::scope::derive_vault_id(legacy_root), &path, &SourceSnapshot {
            raw_sha256: crate::ledger::sha256_hex(BODY.as_bytes()), carrier: "markdown",
            body_start_utf8: BODY.len() - legacy_body.len(), searched_body_bytes: legacy_body.len(), capped: false,
        }, legacy_body, start..start + "Canonical body".len(), None).unwrap();
        let result = source_location::resolve_source(&SourceScope { vault: legacy_root, vault_id: &locator.vault_id, admits: &|_| true }, &locator).unwrap();
        assert!(matches!(result, ResolveSourceResult::Unavailable { .. }), "a legacy root cannot interpret nested selected body as legacy source: {result:?}");
        assert_eq!(fs::read(f.root.join("page.md")).unwrap(), BODY.as_bytes());
    });
}

#[test]
fn selected_public_search_result_never_serializes_private_canonical_carrier(){
    let f=Fixture::new("search-carrier-wire-privacy");
    f.run(||{
        let mut canonical=f.stored();canonical["value"]["type"]=json!({"kind":"string","value":"Agent"});
        for key in ["recent","memory","preferences","_private"]{canonical["value"][key]=json!({"kind":"string","value":"neverprivateneedle"});}
        canonical["value"]["exact"]=json!({"kind":"decimal","value":"1e400"});properties(&f,&canonical);
        paired_body(&f,"# Public search body\nvisiblepublicneedle\n");
        let found=search::vault_search_in(&CorpusCache::new(1),&f.root,"visiblepublicneedle",10).unwrap();assert_eq!(found.total,1);assert_eq!(found.hits.len(),1);
        let wire=serde_json::to_string(&found).unwrap();assert!(!wire.contains("neverprivateneedle"));assert!(!wire.contains("canonicalProperties"));assert!(!wire.contains("unavailableLegacyKeys"));
        assert_eq!(f.stored(),canonical);assert_eq!(fs::read(f.root.join("page.md")).unwrap(),b"# Public search body\nvisiblepublicneedle\n");
    });
}
