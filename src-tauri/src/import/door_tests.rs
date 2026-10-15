// Included inside mcp::tests so the real note doors are exercised.
#[test]
fn no_agent_write_door_changes_a_stamped_key() {
    let vault = fields_vault("mcp-import-stamps");
    let path = "tasks/brief.md";
    let original = TASK.replace(
        "status: todo",
        "status: todo\nsource_system: linear\nsource_record_id: abc\nimport_hash: original",
    );
    write(&vault, path, &original);
    let calls = [
        (
            "update_frontmatter",
            args_of(json!({"path": path, "patch": {"import_hash": null}})),
        ),
        (
            "set_fields",
            args_of(json!({"path": path, "set": {"source_record_id": "another"}})),
        ),
        (
            "create_note",
            args_of(
                json!({"folder": "tasks", "slug": "forged", "frontmatter": {"generated": "forged"}, "body": "Body"}),
            ),
        ),
    ];
    for (door, args) in calls {
        let result = match door {
            "update_frontmatter" => tool_update_frontmatter(&vault, &args),
            "set_fields" => tool_set_fields(&vault, &args),
            "create_note" => tool_create_note(&vault, &args),
            _ => unreachable!(),
        };
        assert!(
            result
                .unwrap_err()
                .starts_with("Agent writes may not add, change or remove"),
            "{door}"
        );
        assert_eq!(std::fs::read_to_string(vault.join(path)).unwrap(), original);
        assert!(!vault.join("tasks/forged.md").exists());
    }
    let unclosed = "---\nsource_system: notion\n# close-me";
    write(&vault, path, unclosed);
    assert!(tool_append(
        &vault,
        &args_of(json!({"path": path, "content": "---\nBody"}))
    )
    .unwrap_err()
    .contains("source_system"));
    assert_eq!(std::fs::read_to_string(vault.join(path)).unwrap(), unclosed);
    assert!(
        tool_edit_note(&vault, &edit_args(path, "# close-me", "---\nBody"))
            .unwrap_err()
            .contains("source_system")
    );
    assert_eq!(std::fs::read_to_string(vault.join(path)).unwrap(), unclosed);
    let _ = std::fs::remove_dir_all(vault);
}

#[test]
fn every_note_door_is_covered_by_the_stamp_guard() {
    let manifest: Value = serde_json::from_str(crate::policy::tools::TOOLS_JSON).unwrap();
    let mut actual: Vec<_> = manifest["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|row| row["door"] == "note")
        .map(|row| row["name"].as_str().unwrap())
        .collect();
    actual.sort();
    assert_eq!(
        actual,
        [
            "append_to_note",
            "create_note",
            "edit_note",
            "edit_sheet",
            "set_fields",
            "update_frontmatter"
        ]
    );
    // The sixth door changes only its table body: its normal edit must keep
    // the complete imported frontmatter, including the writer-owned values.
    let vault = temp_vault("mcp-import-sheet");
    let prefix = "---\nsource_system: linear\nimport_hash: original\n---\n";
    write(
        &vault,
        "notes/budget.md",
        &format!("{prefix}{SHEET_BUDGET}"),
    );
    tool_edit_sheet(&vault, &sheet_edit_args("notes/budget.md")).unwrap();
    let landed = std::fs::read_to_string(vault.join("notes/budget.md")).unwrap();
    assert!(landed.starts_with(prefix));
    assert!(landed.contains("Total,=SUM(B2:B3)"));
    let _ = std::fs::remove_dir_all(vault);
}

#[test]
fn a_status_patch_on_an_imported_page_still_lands() {
    let vault = fields_vault("mcp-import-status");
    let original = TASK.replace(
        "status: todo",
        "status: todo\nsource_system: linear\nimport_hash: original",
    );
    write(&vault, "tasks/brief.md", &original);
    tool_set_fields(
        &vault,
        &args_of(json!({"path": "tasks/brief.md", "set": {"status": "In Progress"}})),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(vault.join("tasks/brief.md")).unwrap(),
        original.replace("status: todo", "status: in-progress")
    );
    let _ = std::fs::remove_dir_all(vault);
}

#[test]
fn governed_types_speak_before_stamps() {
    let before = "---\ntype: Agent\nsource_system: notion\n---\nBody";
    assert_eq!(
        governed_bytes_check(before, "Body"),
        Err(AGENT_DOC_REFUSAL.into())
    );
    assert_eq!(
        governed_bytes_check("Body", before),
        Err(AGENT_DOC_REFUSAL.into())
    );
}
