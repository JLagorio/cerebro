use super::answer::*;
use super::{
    agent_limits::{self, ReadLimits},
    read::read,
};
use serde_json::{json, Value};
fn limits() -> &'static ReadLimits {
    &agent_limits::table().read
}
fn node(id: &str) -> Value {
    json!({"id":id,"type":"text","text":id,"x":0,"y":0,"width":10,"height":20})
}
fn output(source: Value, request: Request, caps: &ReadLimits) -> Value {
    serde_json::from_str(
        &answer(
            &read(&source.to_string()).unwrap(),
            "hash",
            "boards/plan.canvas",
            &request,
            caps,
            |_| Target::Missing,
        )
        .unwrap(),
    )
    .unwrap()
}
#[test]
fn empty_is_measured_and_bounds_are_absent() {
    let out = output(json!({}), Request::default(), limits());
    assert_eq!(
        out["board"],
        json!({"nodes":0,"edges":0,"by_type":{"text":0,"file":0,"link":0,"group":0},"bounds":null,"drawings":0,"cerebro":null})
    );
    assert_eq!(out["truncated"], false);
}
#[test]
fn reads_content_shapes_ends_and_all_target_states() {
    let mut nodes = vec![node("text")];
    for path in ["exists.md", "missing.md", "secret/a.md", "../outside"] {
        nodes.push(
            json!({"id":path,"type":"file","file":path,"x":10,"y":-20,"width":20,"height":30}),
        );
    }
    let board=read(&json!({"nodes":nodes,"edges":[{"id":"e","fromNode":"text","toNode":"ghost","label":"kept","toEnd":"arrow"}],"cerebro":{"version":1,"cards":{"text":{"shape":"diamond"}}}}).to_string()).unwrap();
    let mut checked = vec![];
    let result = answer(
        &board,
        "h",
        "boards/plan.canvas",
        &Request::default(),
        limits(),
        |path| {
            checked.push(path.to_owned());
            match path {
                "exists.md" => Target::Exists,
                "missing.md" => Target::Missing,
                "secret/a.md" => Target::Unchecked,
                _ => Target::Outside,
            }
        },
    )
    .unwrap();
    let result: Value = serde_json::from_str(&result).unwrap();
    assert_eq!(result["nodes"][0]["kind"], "diamond");
    assert_eq!(
        result["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .skip(1)
            .map(|n| n["target"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["exists", "missing", "unchecked", "outside"]
    );
    assert_eq!(result["edges"][0]["dangling"], json!(["ghost"]));
    assert_eq!(result["edges"][0]["label"], "kept");
    assert_eq!(checked.len(), 4);
}
#[test]
fn node_limit_stops_before_the_next_node_and_numbers_remain_file_numbers() {
    let nodes: Vec<_> = (0..501).map(|n| node(&format!("n{n}"))).collect();
    let source = json!({"nodes":nodes});
    let first = output(source.clone(), Request::default(), limits());
    assert_eq!(first["nodes"].as_array().unwrap().len(), 500);
    assert_eq!(first["truncated"], true);
    assert_eq!(first["next_start"], 501);
    let next = output(
        source,
        Request {
            start: Some(501),
            ids: None,
        },
        limits(),
    );
    assert_eq!(next["nodes"][0]["n"], 501);
    assert_eq!(next["truncated"], false);
}
#[test]
fn byte_limit_stops_before_a_later_node_and_cuts_a_first_large_node() {
    let mut a = node("a");
    a["text"] = json!("😀".repeat(30_000));
    let mut b = node("b");
    b["text"] = json!("b".repeat(80_000));
    let source = json!({"nodes":[a,b]});
    let board = read(&source.to_string()).unwrap();
    let raw = answer(
        &board,
        "h",
        "boards/plan.canvas",
        &Request::default(),
        limits(),
        |_| Target::Missing,
    )
    .unwrap();
    assert!(raw.len() <= 100_000);
    let out: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(out["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(out["next_start"], 2);
    assert_eq!(out["truncated"], true);
    assert!(!out["warnings"].as_array().unwrap().is_empty());
    assert!(!out["nodes"][0]["text"].as_str().unwrap().is_empty());
}
#[test]
fn a_hubs_connections_are_bounded_warned_and_not_repeated() {
    let edges: Vec<_> = (0..1000)
        .map(|n| json!({"id":format!("e{n}"),"fromNode":"a","toNode":"b","label":"x".repeat(200)}))
        .collect();
    let source = json!({"nodes":[node("a"),node("b")],"edges":edges});
    let raw = answer(
        &read(&source.to_string()).unwrap(),
        "h",
        "boards/plan.canvas",
        &Request::default(),
        limits(),
        |_| Target::Missing,
    )
    .unwrap();
    assert!(raw.len() <= 100_000);
    let out: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(out["truncated"], true);
    assert!(out["edges"].as_array().unwrap().len() < 1000);
    let ids: std::collections::HashSet<_> = out["edges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), out["edges"].as_array().unwrap().len());
}
#[test]
fn ids_select_in_file_order_and_warn_about_unknown_ids() {
    let out = output(
        json!({"nodes":[node("a"),node("b"),node("c")],"edges":[{"id":"e","fromNode":"a","toNode":"c"}]}),
        Request {
            start: None,
            ids: Some(vec!["c".into(), "a".into(), "gone".into(), "a".into()]),
        },
        limits(),
    );
    assert_eq!(
        out["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["a", "c"]
    );
    assert_eq!(out["nodes"][1]["n"], 3);
    assert_eq!(out["edges"].as_array().unwrap().len(), 1);
    assert_eq!(
        out["warnings"],
        json!(["No node with id \"gone\" on this board."])
    );
}
#[test]
fn malformed_arguments_refuse() {
    for value in [
        json!({"start":0}),
        json!({"start":1.5}),
        json!({"start":"1"}),
        json!({"ids":1}),
        json!({"ids":[1]}),
        json!({"ids":[],"start":1}),
        json!({"ids":vec!["a";501]}),
    ] {
        assert!(Request::parse(&value, limits()).is_err(), "{value}");
    }
    assert!(Request::parse(&json!({"start":1}), limits()).is_ok());
}
#[test]
fn seeded_varied_boards_never_pass_the_response_byte_cap() {
    let caps = ReadLimits {
        nodes: 20,
        bytes: 4000,
        ids: 20,
    };
    let mut seed = 17_u64;
    for _ in 0..25 {
        let mut nodes = vec![];
        let mut edges = vec![];
        for n in 0..40 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let mut item = node(&format!("n{n}"));
            item["text"] = json!("\n😀".repeat((seed % 1000) as usize));
            nodes.push(item);
            edges.push(json!({"id":format!("e{n}"),"fromNode":format!("n{n}"),"toNode":"n0"}));
        }
        let board = read(&json!({"nodes":nodes,"edges":edges}).to_string()).unwrap();
        let raw = answer(
            &board,
            "h",
            "boards/plan.canvas",
            &Request::default(),
            &caps,
            |_| Target::Missing,
        )
        .unwrap();
        assert!(raw.len() <= caps.bytes);
        let out: Value = serde_json::from_str(&raw).unwrap();
        assert!(!out["nodes"].as_array().unwrap().is_empty());
    }
}

#[test]
fn out_of_range_start_and_caps_name_the_request() {
    let board = read("{}").unwrap();
    assert_eq!(
        answer(
            &board,
            "h",
            "a.canvas",
            &Request {
                start: Some(1),
                ids: None
            },
            limits(),
            |_| Target::Missing
        )
        .unwrap_err(),
        "`start` counts nodes from 1, and a.canvas has 0."
    );
    assert_eq!(
        Request::parse(&json!({"start":1,"ids":[]}), limits()).unwrap_err(),
        "Pass `start` or `ids`, not both."
    );
    assert_eq!(
        Request::parse(&json!({"ids":vec!["a";501]}), limits()).unwrap_err(),
        "`ids` holds at most 500 ids; this call has 501."
    );
}
#[test]
fn unknown_id_warnings_cannot_crowd_out_the_first_requested_node() {
    let mut ids: Vec<_> = (0..499)
        .map(|i| format!("{i}{}", "😀".repeat(128)))
        .collect();
    ids.push("a".into());
    let out = output(
        json!({"nodes":[node("a")]}),
        Request {
            start: None,
            ids: Some(ids),
        },
        limits(),
    );
    assert_eq!(out["nodes"][0]["id"], "a");
    assert!(out.to_string().len() <= limits().bytes);
    assert!(out["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .any(|w| w.as_str().unwrap().contains("other requested ids")));
}
#[test]
fn ids_cut_reports_a_count_and_preserves_the_file_number() {
    let caps = ReadLimits {
        nodes: 1,
        bytes: 100_000,
        ids: 3,
    };
    let out = output(
        json!({"nodes":[node("a"),node("b"),node("c")]}),
        Request {
            start: None,
            ids: Some(vec!["b".into(), "c".into()]),
        },
        &caps,
    );
    assert_eq!(out["nodes"][0]["n"], 2);
    assert_eq!(out["next_start"], 3);
    assert_eq!(
        out["warnings"],
        json!(["Only 1 of the 2 nodes asked for came back; ask for the rest in another call."])
    );
}

#[test]
fn an_edge_cut_from_a_hub_still_belongs_to_its_later_node() {
    let caps = ReadLimits {
        nodes: 500,
        bytes: 2000,
        ids: 500,
    };
    let mut edges: Vec<_> = (0..30)
        .map(|i| json!({"id":format!("e{i}"),"fromNode":"a","toNode":"c","label":"x".repeat(100)}))
        .collect();
    edges.push(json!({"id":"last","fromNode":"a","toNode":"b","label":"kept on continuation"}));
    let source = json!({"nodes":[node("a"),node("b"),node("c")],"edges":edges});
    let first = output(source.clone(), Request::default(), &caps);
    assert_eq!(first["next_start"], 2);
    assert!(!first["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["id"] == "last"));
    let next = output(
        source,
        Request {
            start: Some(2),
            ids: None,
        },
        &caps,
    );
    assert_eq!(next["nodes"][0]["id"], "b");
    assert!(next["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["id"] == "last"));
}
