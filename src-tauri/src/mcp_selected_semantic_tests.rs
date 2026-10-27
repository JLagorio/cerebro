//! Actual selected SQLite + existing MCP helper dispatch. No native run/agent
//! admission or selected activation is claimed by these read-only unit cases.
use super::*;
use crate::workspace_service::{authority, types::values::ValueSchema, value};
use rusqlite::Connection;
use serde_json::json;
use std::{fs, path::{Path, PathBuf}};
const WORKSPACE: &str = "3ee5b6eb-9f80-4bac-9538-f2a0c5938a62";
struct Fixture { root: PathBuf, origin: PathBuf, db: PathBuf, next: usize }
fn private(path: &Path, directory: bool) {
    use std::os::unix::fs::PermissionsExt as _;
    fs::set_permissions(path, fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 })).unwrap();
}
impl Fixture {
    fn new(label: &str) -> Self {
        let root = crate::vault::testutil::temp_vault(&format!("selected-semantic-{label}"));
        let origin = crate::vault::testutil::temp_vault(&format!("selected-semantic-origin-{label}"));
        let namespace = origin.join("workspaces"); let directory = namespace.join(WORKSPACE);
        fs::create_dir_all(&directory).unwrap(); for path in [&origin, &namespace, &directory] { private(path, true); }
        let db = directory.join("workspace.db");
        let conn = Connection::open(&db).unwrap(); conn.execute_batch(include_str!("workspace_service/selected_schema.sql")).unwrap();
        conn.execute("INSERT INTO workspace VALUES (1,2,?1,1,1)", [WORKSPACE]).unwrap(); drop(conn); private(&db, false);
        fs::write(namespace.join("bindings.v1.json"), json!({"version":1,"bindings":[{"workspaceId":WORKSPACE,"bodyRoot":root}]}).to_string()).unwrap(); private(&namespace.join("bindings.v1.json"), false);
        crate::vault::testutil::write(&root, ".cerebro/workspace-format.json", &json!({"format":2,"authority":"sqlite_metadata","state":"activated","workspaceId":WORKSPACE}).to_string());
        Self { root, origin, db, next: 1 }
    }
    fn insert(&mut self, path: &str, title: &str, properties: Value) {
        let body = format!("# {title}\n\nCanonical read fixture.\n");
        crate::vault::testutil::write(&self.root, path, &body);
        let tagged = json!({"kind":"object","value":properties}); value::decode_tagged(&tagged.to_string()).unwrap();
        let id = format!("00000000-0000-4000-8000-{:012x}", self.next); self.next += 1;
        Connection::open(&self.db).unwrap().execute("INSERT INTO records VALUES (?1,?2,1,?3,?4)", rusqlite::params![id,path,crate::ledger::sha256_hex(body.as_bytes()),tagged.to_string()]).unwrap();
    }
    fn type_doc(&mut self, path: &str, name: &str, fields: &Value) {
        let fields = value::decode_json(&fields.to_string(), ValueSchema::Plain).unwrap();
        self.insert(path, name, json!({"type":{"kind":"string","value":"Type"},"fields":fields}));
    }
    fn run<T>(&self, operation: impl FnOnce() -> T) -> T { authority::with_fixture_context(authority::AuthorityContext::new(self.origin.clone()), operation) }
    fn grant(&self, folders: Option<Vec<String>>) -> RunGrant { RunGrant { actor: "human:me".into(), run_id: "11111111111111111111111111111111".into(), scope: Some(vec![]), read_scope: folders, tools: Some(vec!["query_records".into(),"describe_database".into(),"suggest_view".into(),"list_agenda".into()]), chain: vec!["human:me".into()], vault: Some(self.root.clone()), asks: WriteAsks::UNASKED } }
    fn database_bytes(&self) -> Vec<u8> { fs::read(&self.db).unwrap() }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); let _ = fs::remove_dir_all(&self.origin); } }
fn day() -> chrono::NaiveDate { chrono::NaiveDate::from_ymd_opt(2026,10,23).unwrap() }
fn text(result: Value) -> String { result["content"][0]["text"].as_str().expect("actual MCP text result").to_owned() }
fn rows(answer: &str) -> (Vec<String>, Vec<Value>) {
    let mut paths = Vec::new(); let mut values = Vec::new(); let lines = answer.lines().collect::<Vec<_>>();
    for pair in lines.windows(2) {
        if let Some(header) = pair[0].strip_prefix("- ") {
            if let Some((path, _)) = header.split_once(" — ") {
                if pair[1].starts_with("  {") { paths.push(path.to_owned()); values.push(serde_json::from_str(pair[1].trim()).expect("canonical tagged result row")); }
            }
        }
    }
    (paths, values)
}
fn cases() -> Value { serde_json::from_str(include_str!("../../shared/workspace/values.v1.json")).unwrap() }
fn query_case(name: &str) {
    let all = cases(); let case = all["selectedQueryCases"].as_array().unwrap().iter().find(|case|case["name"]==name).unwrap();
    let mut f = Fixture::new(name); f.type_doc("types/record.md", "Record", &case["type"]["fields"]);
    for record in case["records"].as_array().unwrap() {
        let mut properties = record["properties"].as_object().unwrap().clone(); properties.insert("type".into(),json!({"kind":"string","value":"Record"}));
        f.insert(record["path"].as_str().unwrap(), "Record row", Value::Object(properties));
    }
    let args = case.get("argsSource").and_then(Value::as_str).map(|source|serde_json::from_str::<Value>(source).unwrap()).unwrap_or_else(||case["args"].clone());
    let before = f.database_bytes();
    f.run(|| {
        let answer = scoped_query_records(&vault::corpus::CorpusCache::new(1), &f.root, args.as_object().unwrap(), &f.grant(None), chrono_tz::UTC, day());
        if case["expect"].get("error").is_some() {
            assert!(answer.is_err(), "unsupported selected query must refuse: {name}");
            if case["expect"]["error"] == "unsupported_projection" {
                let cause = crate::workspace_service::selected::query_records(&f.root, &|_|true, &args, chrono_tz::UTC, day()).unwrap_err();
                assert_eq!(cause.kind, crate::workspace_service::types::selected::AuthorityErrorKind::UnsupportedProjection, "actual typed refusal for {name}");
            }
        } else {
            let answer = answer.unwrap_or_else(|error|panic!("actual MCP selected query {name}: {error}"));
            let (paths, values) = rows(&answer);
            assert_eq!(serde_json::to_value(paths).unwrap(), case["expect"]["paths"], "selected matched paths {name}");
            assert_eq!(serde_json::to_value(values).unwrap(), case["expect"]["values"], "canonical value/absence preservation {name}");
        }
    });
    assert_eq!(f.database_bytes(), before, "query must never alter canonical metadata");
}

#[test]
fn selected_query_shared_case_01() { query_case("literal 007 never equals numeric seven"); }

#[test]
fn selected_query_shared_case_02() { query_case("tagged null matches explicit null but not absence"); }

#[test]
fn selected_query_shared_case_03() { query_case("empty operator intentionally matches absence and null but result preserves presence"); }

#[test]
fn selected_query_shared_case_04() { query_case("adjacent large decimals do not collapse to one f64"); }

#[test]
fn selected_query_shared_case_05() { query_case("huge finite exponents compare without materializing exponent zeros"); }

#[test]
fn selected_query_shared_case_06() { query_case("tiny exponent remains greater than zero"); }

#[test]
fn selected_query_shared_case_07() { query_case("numeric zero equality retains every original spelling"); }

#[test]
fn selected_query_shared_case_08() { query_case("decimal spelling is retained though numeric equality is mathematical"); }

#[test]
fn selected_query_shared_case_09() { query_case("exact numeric sorting is separate from textual collation"); }

#[test]
fn selected_query_shared_case_10() { query_case("cross-kind ordered comparison refuses before evaluating records"); }

#[test]
fn selected_query_shared_case_11() { query_case("object predicate is unsupported and never flattened"); }

#[test]
fn selected_query_shared_case_12() { query_case("relation predicate remains unsupported without identity semantics"); }

#[test]
fn selected_query_shared_case_13() { query_case("raw unsafe integer operand refuses without coercion"); }

#[test]
fn selected_query_shared_case_14() { query_case("raw fractional operand requires exact tagged lexeme"); }

#[test]
fn selected_query_shared_case_15() { query_case("declared date uses shared calendar semantics"); }

#[test]
fn selected_query_shared_case_16() { query_case("date-looking text remains literal under text declaration"); }

#[test]
fn selected_query_shared_case_17() { query_case("unsupported predicate on undeclared mixed values refuses entire query"); }

#[test]
fn selected_query_shared_case_18() { query_case("present raw null operand means explicit null not absence"); }

#[test]
fn selected_query_shared_case_19() { query_case("missing value key is distinct from explicit raw null"); }

#[test]
fn selected_describe_uses_canonical_type_declaration_despite_unrelated_exact_values() {
    let mut f = Fixture::new("describe-canonical"); f.type_doc("types/record.md", "Record", &json!({"value":"number"}));
    f.insert("row.md", "Canonical row", json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"decimal","value":"1e400"},"relation":{"kind":"relation","spelling":"[[Unknown]]","fragment":null,"resolution":{"status":"unresolved"}}}));
    let before = f.database_bytes();
    f.run(|| {
        let response = tool_describe_database(&vault::corpus::CorpusCache::new(1), &f.root, json!({"type":"Record"}).as_object().unwrap(), &f.grant(None), chrono_tz::UTC, day()).unwrap();
        let answer = text(response); assert!(answer.contains("Record")); assert!(answer.contains("types/record.md")); assert!(answer.contains("value")); assert!(answer.contains("number"));
    }); assert_eq!(f.database_bytes(), before);
}
#[test]
fn selected_visible_duplicate_type_meaning_refuses_instead_of_picking_scan_order() {
    let mut f = Fixture::new("duplicate-type"); f.type_doc("types/one.md", "Record", &json!({"value":"number"})); f.type_doc("types/two.md", "record", &json!({"value":"text"}));
    f.insert("row.md", "Canonical row", json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"decimal","value":"7"}}));
    f.run(|| {
        let args = json!({"type":"Record"});
        assert!(tool_describe_database(&vault::corpus::CorpusCache::new(1), &f.root, args.as_object().unwrap(), &f.grant(None), chrono_tz::UTC, day()).is_err());
        let error = crate::workspace_service::selected::describe_database(&f.root, &|_|true, &args, chrono_tz::UTC, day()).unwrap_err();
        assert_eq!(error.kind,crate::workspace_service::types::selected::AuthorityErrorKind::UnsupportedProjection);
    });
}
#[test]
fn selected_unreadable_type_duplicate_cannot_lend_schema_or_result_rows() {
    let mut f = Fixture::new("scoped-types"); f.type_doc("types/record.md", "Record", &json!({"value":"number"})); f.type_doc("hidden/duplicate.md", "record", &json!({"value":"text"}));
    f.insert("visible/row.md", "Visible row", json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"decimal","value":"7"}}));
    f.insert("hidden/row.md", "Hidden row", json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"decimal","value":"90071992547409931234567890.001"}}));
    f.run(|| {
        let answer = scoped_query_records(&vault::corpus::CorpusCache::new(1), &f.root, json!({"type":"Record","fields":["value"]}).as_object().unwrap(), &f.grant(Some(vec!["types".into(),"visible".into()])), chrono_tz::UTC, day()).unwrap();
        let (paths, values) = rows(&answer); assert_eq!(paths,vec!["visible/row.md"]); assert_eq!(values,vec![json!({"value":{"kind":"decimal","value":"7"}})]); assert!(!answer.contains("90071992547409931234567890.001")); assert!(!answer.contains("hidden/"));
    });
}
#[test]
fn selected_agenda_uses_declared_tagged_dates_and_instants_without_reading_text_as_a_date() {
    let mut f = Fixture::new("canonical-agenda"); f.type_doc("types/record.md", "Record", &json!({"when":"date","looks":"text"}));
    f.insert("day.md", "Calendar day", json!({"type":{"kind":"string","value":"Record"},"when":{"kind":"date","value":"2026-10-23"},"unrelated":{"kind":"decimal","value":"1e400"}}));
    f.insert("instant.md", "Zoned instant", json!({"type":{"kind":"string","value":"Record"},"when":{"kind":"instant","value":"2026-10-23T09:00:00Z"}}));
    f.insert("text.md", "Date-looking text", json!({"type":{"kind":"string","value":"Record"},"looks":{"kind":"string","value":"2026-10-23"}}));
    let before = f.database_bytes();
    f.run(|| {
        let response = tool_list_agenda(&vault::corpus::CorpusCache::new(1), &f.root, json!({"type":"Record","start":"2026-10-23","end":"2026-10-24"}).as_object().unwrap(), &f.grant(None), chrono_tz::UTC).unwrap();
        let answer = text(response); assert!(answer.contains("day.md")); assert!(answer.contains("instant.md")); assert!(!answer.contains("text.md")); assert!(answer.contains("2026-10-23"));
    }); assert_eq!(f.database_bytes(),before);
}
#[test]
fn selected_view_suggestion_retains_exact_numeric_operand_and_writes_no_view_file() {
    let mut f = Fixture::new("canonical-view"); f.type_doc("types/record.md", "Record", &json!({"value":"number"}));
    f.insert("row.md", "Exact row", json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"decimal","value":"1e400"}}));
    let args = json!({"database":"Record","view":{"name":"Precise","filters":{"all":[{"field":"value","op":"gt","value":{"kind":"decimal","value":"90071992547409931234567890.001"}}]},"presentation":{"type":"table","columns":[{"field":"value"}]}}});
    let before = f.database_bytes();
    f.run(|| {
        let answer = text(tool_suggest_view(&vault::corpus::CorpusCache::new(1), &f.root, args.as_object().unwrap(), &f.grant(None)).unwrap());
        let proposed: Value = serde_json::from_str(&answer).unwrap(); assert_eq!(proposed["suggested"]["database"],"Record"); assert_eq!(proposed["suggested"]["view"]["filters"],args["view"]["filters"]);
    }); assert_eq!(f.database_bytes(),before); assert!(!f.root.join("views").exists());
}
#[test]
fn selected_query_output_retains_unknown_tagged_maps_and_null_without_legacy_projection() {
    let mut f = Fixture::new("canonical-output"); f.type_doc("types/record.md", "Record", &json!({"value":"text"}));
    let unknown = json!({"kind":"object","value":{"null":{"kind":"null"},"precise":{"kind":"decimal","value":"1e400"}}});
    f.insert("row.md", "Unknown map", json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"string","value":"visible"},"unknown":unknown}));
    f.run(|| {
        let answer = scoped_query_records(&vault::corpus::CorpusCache::new(1), &f.root, json!({"type":"Record","fields":["value","unknown"]}).as_object().unwrap(), &f.grant(None), chrono_tz::UTC, day()).unwrap();
        let (paths, values) = rows(&answer); assert_eq!(paths,vec!["row.md"]); assert_eq!(values,vec![json!({"value":{"kind":"string","value":"visible"},"unknown":unknown})]);
    });
}

#[test]
fn selected_query_shared_case_20() { query_case("zoned instant output retains its tag and nanosecond lexeme"); }

#[test]
fn selected_query_shared_case_21() { query_case("bounded exact comparator handles exponent beyond machine integer range"); }

#[test]
fn selected_query_shared_case_22() { query_case("exact decimal between accepts bounded tagged operand list"); }

#[test]
fn selected_query_shared_case_23() { query_case("false boolean does not become absence null or string"); }

#[test]
fn selected_declared_multiselect_reads_flat_string_array_without_losing_tags() {
    let mut f = Fixture::new("canonical-multi"); f.type_doc("types/record.md", "Record", &json!({"value":"multiselect"}));
    let selected = json!({"kind":"array","value":[{"kind":"string","value":"red"},{"kind":"string","value":"blue"}]});
    f.insert("blue.md", "Blue record", json!({"type":{"kind":"string","value":"Record"},"value":selected}));
    f.insert("green.md", "Green record", json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"array","value":[{"kind":"string","value":"green"}]}}));
    f.run(|| {
        let args = json!({"type":"Record","fields":["value"],"filters":{"all":[{"field":"value","op":"any_of","value":["blue"]}]}});
        let answer = scoped_query_records(&vault::corpus::CorpusCache::new(1), &f.root, args.as_object().unwrap(), &f.grant(None), chrono_tz::UTC, day()).unwrap();
        let (paths, values) = rows(&answer); assert_eq!(paths, vec!["blue.md"]); assert_eq!(values, vec![json!({"value":selected})]);
    });
}
#[test]
fn selected_unsupported_nested_array_refuses_before_a_false_rule_short_circuits_evaluation() {
    let mut f = Fixture::new("canonical-unsupported-before-filter"); f.type_doc("types/record.md", "Record", &json!({"value":"multiselect"}));
    f.insert("row.md", "Actual row", json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"array","value":[{"kind":"string","value":"a"},{"kind":"object","value":{"x":{"kind":"string","value":"b"}}}]}}));
    f.run(|| {
        let args = json!({"type":"Record","fields":["value"],"filters":{"all":[{"field":"title","op":"equals","value":"Never this title"},{"field":"value","op":"any_of","value":["a"]}]}});
        assert!(scoped_query_records(&vault::corpus::CorpusCache::new(1), &f.root, args.as_object().unwrap(), &f.grant(None), chrono_tz::UTC, day()).is_err());
        let cause = crate::workspace_service::selected::query_records(&f.root, &|_|true, &args, chrono_tz::UTC, day()).unwrap_err();
        assert_eq!(cause.kind,crate::workspace_service::types::selected::AuthorityErrorKind::UnsupportedProjection);
    });
}


fn mixed_temporal_sort(direction: &str, reverse_identity_order: bool) {
    // Exercise both incoming path orientations. Insertion order determines
    // canonical record ids, so a broken comparator cannot hide behind its id tie.
    for date_first_in_paths in [true,false] {
        let mut f=Fixture::new("mixed-temporal-sort");
        f.type_doc("types/record.md","Record",&json!({"value":"date"}));
        let day_path=if date_first_in_paths { "a-day.md" } else { "z-day.md" };
        let instant_path=if date_first_in_paths { "z-instant.md" } else { "a-instant.md" };
        let calendar=json!({"kind":"date","value":"2026-10-23"});
        let instant=json!({"kind":"instant","value":"2026-10-23T09:00:00.000000001Z"});
        let mut input=vec![(day_path,"Calendar day",calendar.clone()),(instant_path,"Timed instant",instant.clone())];
        if reverse_identity_order { input.reverse(); }
        for (path,title,value) in input { f.insert(path,title,json!({"type":{"kind":"string","value":"Record"},"value":value})); }
        f.run(|| {
            let args=json!({"type":"Record","fields":["value"],"sort":[{"field":"value","dir":direction}]});
            let answer=scoped_query_records(&vault::corpus::CorpusCache::new(1),&f.root,args.as_object().unwrap(),&f.grant(None),chrono_tz::UTC,day()).unwrap();
            let (paths,values)=rows(&answer);
            let expected=if direction=="asc" { vec![day_path,instant_path] } else { vec![instant_path,day_path] };
            assert_eq!(paths,expected,"direction={direction}, reverse ids={reverse_identity_order}, date path first={date_first_in_paths}");
            let expected_values=if direction=="asc" { vec![json!({"value":calendar}),json!({"value":instant})] } else { vec![json!({"value":instant}),json!({"value":calendar})] };
            assert_eq!(values,expected_values,"sorting must retain temporal tags and exact nanoseconds");
        });
    }
}
#[test]
fn selected_mixed_date_instant_sort_ascending() { mixed_temporal_sort("asc",false); }
#[test]
fn selected_mixed_date_instant_sort_descending() { mixed_temporal_sort("desc",false); }
#[test]
fn selected_mixed_date_instant_sort_ascending_reversed_record_ids() { mixed_temporal_sort("asc",true); }
#[test]
fn selected_mixed_date_instant_sort_descending_reversed_record_ids() { mixed_temporal_sort("desc",true); }


#[test]
fn selected_temporal_sort_orders_calendar_day_before_exact_midnight_instant() {
    let mut f=Fixture::new("temporal-midnight-tag-order");
    f.type_doc("types/record.md","Record",&json!({"value":"date"}));
    // The instant gets the lower canonical id; temporal tag order must win.
    f.insert("a-instant.md","Midnight instant",json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"instant","value":"2026-10-23T00:00:00Z"}}));
    f.insert("z-day.md","Calendar day",json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"date","value":"2026-10-23"}}));
    f.run(|| {
        for (dir,expected) in [("asc",vec!["z-day.md","a-instant.md"]),("desc",vec!["a-instant.md","z-day.md"])] {
            let args=json!({"type":"Record","fields":["value"],"sort":[{"field":"value","dir":dir}]});
            let answer=scoped_query_records(&vault::corpus::CorpusCache::new(1),&f.root,args.as_object().unwrap(),&f.grant(None),chrono_tz::UTC,day()).unwrap();
            let (paths,values)=rows(&answer); assert_eq!(paths,expected,"{dir}");
            let tags=values.iter().map(|value|value["value"]["kind"].as_str().unwrap()).collect::<Vec<_>>();
            assert_eq!(tags,if dir=="asc" { vec!["date","instant"] } else { vec!["instant","date"] });
        }
    });
}
#[test]
fn selected_temporal_sort_uses_civil_wall_time_then_absolute_nanosecond_fold_tie() {
    let mut f=Fixture::new("temporal-fold-order");
    f.type_doc("types/record.md","Record",&json!({"value":"date"}));
    // Reverse the two equal-wall-time records' ids. A third, later absolute
    // instant has an earlier displayed wall time: civil policy is explicit.
    for (path,instant) in [
        ("a-second-fold.md","2026-11-01T01:30:00.000000001-05:00"),
        ("b-first-fold.md","2026-11-01T01:30:00.000000001-04:00"),
        ("c-earlier-wall.md","2026-11-01T01:15:00.000000001-05:00"),
    ] { f.insert(path,path,json!({"type":{"kind":"string","value":"Record"},"value":{"kind":"instant","value":instant}})); }
    f.run(|| {
        for (dir,expected) in [("asc",vec!["c-earlier-wall.md","b-first-fold.md","a-second-fold.md"]),("desc",vec!["a-second-fold.md","b-first-fold.md","c-earlier-wall.md"])] {
            let args=json!({"type":"Record","fields":["value"],"sort":[{"field":"value","dir":dir}]});
            let answer=scoped_query_records(&vault::corpus::CorpusCache::new(1),&f.root,args.as_object().unwrap(),&f.grant(None),chrono_tz::America::New_York,day()).unwrap();
            let (paths,values)=rows(&answer); assert_eq!(paths,expected,"{dir}");
            assert!(values.iter().all(|value|value["value"]["kind"]=="instant" && value["value"]["value"].as_str().unwrap().contains(".000000001")));
        }
    });
}
