//! The Notion tool body, nested under mcp so every existing grant/corpus and
//! operational recorder stays the same boundary. Relinking is Rust-only.
use super::*;
use crate::import::{self, capture, notion, plan};
use std::collections::HashMap;

const TOOL: &str = "import_notion_page";
fn refused(
    grant: &RunGrant,
    page: &str,
    capture: Option<&capture::Capture>,
    why: notion::Refusal,
) -> String {
    if why.composable() {
        if let Some(capture) = capture {
            import::capture::allow_composed(&grant.run_id, page, capture);
        }
    }
    let reply = why.reply();
    record_refusal(
        &grant.run_id,
        TOOL,
        "import_refused",
        &format!("{}:{page}", why.reason),
        &reply,
    );
    reply
}
fn slug(title: &str) -> String {
    let mut out = String::new();
    let mut separator = false;
    for c in title.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            if separator && !out.is_empty() {
                out.push('-');
            }
            out.push(c);
            separator = false;
        } else {
            separator = true;
        }
        if out.len() >= 120 {
            break;
        }
    }
    if out.is_empty() {
        "notion-page".into()
    } else {
        out
    }
}
fn landing(folder: &str, stem: &str) -> String {
    let folder = folder.trim_end_matches('/');
    if folder.is_empty() {
        format!("{stem}.md")
    } else {
        format!("{folder}/{stem}.md")
    }
}
fn readable_landing(vault: &Path, grant: &RunGrant, path: &str) -> bool {
    grant.may_read(path)
        && vault::write::landing_path(vault, path).is_none_or(|landing| grant.may_read(&landing))
}
fn check_target(vault: &Path, grant: &RunGrant, path: &str) -> Result<WriteReceipt<Agent>, String> {
    // Resolve the actual existing landing, not only the requested folder.
    // Hidden copies are not named to a run that cannot read them.
    if !readable_landing(vault, grant, path) {
        return Err("This run cannot import that page within its read reach.".into());
    }
    if !scope_admits_landing(vault, &grant.scope, path) {
        let refusal = GrantRefusal {
            code: WRITE_OUTSIDE_SCOPE,
            target: path.into(),
            message: format!(
                "This run is scoped to {} and cannot write to {path}.",
                scope_words(&grant.scope)
            ),
        };
        record_grant_refusal(grant, TOOL, &refusal);
        return Err(refusal.message);
    }
    let by = WriteReceipt::run(cleared_for_note(grant, path, Approval::None)?);
    if let Some(why) = import::path_refusal(path)
        .or_else(|| {
            vault::write::landing_path(vault, path)
                .and_then(|landing| import::path_refusal(&landing))
        })
        .or_else(|| vault::write::note_target_refusal(vault, path))
    {
        return Err(why);
    }
    Ok(by)
}
fn governed(before: &str, after: &str) -> Result<(), String> {
    match governed_bytes_refusal(before).or_else(|| governed_bytes_refusal(after)) {
        Some(why) => Err(why.into()),
        None => Ok(()),
    }
}
fn stem(path: &str) -> Option<String> {
    Path::new(path)
        .file_stem()?
        .to_str()
        .filter(|s| !s.contains(['[', ']', '#', '\n', '\r']))
        .map(str::to_owned)
}
/// A stem is a safe wikilink only when another visible vault item cannot
/// claim it. Keeping the original URL is preferable to linking the wrong page.
fn link_stem(path: &str, occupied: &[String]) -> Option<String> {
    let wanted = stem(path)?;
    (!occupied.iter().any(|other| {
        other != path
            && stem(other)
                .is_some_and(|candidate| candidate.to_lowercase() == wanted.to_lowercase())
    }))
    .then_some(wanted)
}
fn unstamp(content: &str) -> Option<(String, Option<String>, Option<String>)> {
    let (yaml, body) = vault::parse::split_frontmatter(content);
    let yaml = yaml?;
    let fields: serde_yaml::Value = serde_yaml::from_str(yaml).ok()?;
    let url = fields
        .get("source_url")
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_owned);
    let method = fields
        .get("import_method")
        .and_then(serde_yaml::Value::as_str)
        .map(str::to_owned);
    let keys = import::import_keys();
    let kept = yaml
        .lines()
        .filter(|line| !keys.iter().any(|key| line.starts_with(&format!("{key}: "))))
        .collect::<Vec<_>>()
        .join("\n");
    let front = if kept.is_empty() {
        String::new()
    } else {
        format!("{kept}\n")
    };
    Some((format!("---\n{front}---\n{body}"), url, method))
}
fn fallback_title(capture: &capture::Capture, page: &str) -> String {
    serde_json::from_str::<Value>(&capture.text)
        .ok()
        .and_then(|v| v.get("title").and_then(Value::as_str).map(str::to_owned))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("Notion page {}", &page[..8]))
}

pub(super) fn call(
    vault: &Path,
    args: &Map<String, Value>,
    grant: &RunGrant,
) -> Result<Value, String> {
    let page =
        arg_str(args, "page").ok_or("import_notion_page needs page: a Notion page link or id")?;
    let page = import::canonical_record_id("notion", &page)?;
    let folder =
        arg_str(args, "folder").ok_or("import_notion_page needs folder: a vault folder")?;
    let captured =
        capture::find(&grant.run_id, &page, Duration::from_secs(3)).ok_or_else(|| {
            refused(
                grant,
                &page,
                None,
                notion::Refusal::new(
                    "capture_missing",
                    "This run has no matching Notion fetch. Fetch this page in this turn first.",
                ),
            )
        })?;
    let body = match args.get("body") {
        None => None,
        Some(Value::String(body)) => Some(body.as_str()),
        _ => return Err("import_notion_page body must be text".into()),
    };
    if body.is_some() && !capture::may_compose(&grant.run_id, &page) {
        return Err(refused(grant,&page,None,notion::Refusal::new("not_a_page","A composed body is accepted only after this page's fetch was refused as truncated, narrated or unhandled_markup.")));
    }
    // Canonical identity selection and every write share the import mutex.
    // A second importer cannot make a copy while this one is landing.
    let _imports = import::lock();
    let (files, occupied) = plan::read_vault(vault)
        .map_err(|_| "Existing imports could not be read; nothing was written.".to_string())?;
    let copies = plan::copy_index(&files);
    let existing = copies
        .get(&("notion".into(), page.clone()))
        .and_then(|copies| copies.first())
        .copied();
    let provisional = existing
        .map(|f| f.path.clone())
        .unwrap_or_else(|| landing(&folder, "notion-page"));
    let _provisional_receipt = check_target(vault, grant, &provisional)?;
    let linkable: HashMap<String, String> = copies
        .iter()
        .filter(|((system, _), _)| system == "notion")
        .filter_map(|((_, id), copies)| {
            copies
                .iter()
                .find(|f| readable_landing(vault, grant, &f.path))
                .and_then(|f| link_stem(&f.path, &occupied))
                .map(|stem| (id.clone(), stem))
        })
        .collect();
    let (title, normalized, method) = if let Some(body) = body {
        let body = notion::composed_body(body)
            .map_err(|why| refused(grant, &page, Some(&captured), why))?;
        let title = fallback_title(&captured, &page);
        let content = if body.starts_with("---\n") {
            body
        } else {
            format!("---\n---\n{body}")
        };
        (
            title,
            notion::Normalized {
                markdown: content,
                counts: notion::Counts::default(),
            },
            Some("agent_composed"),
        )
    } else {
        let parsed = notion::parse(&captured, &page)
            .map_err(|why| refused(grant, &page, Some(&captured), why))?;
        let normalized = notion::normalize(&parsed, &linkable)
            .map_err(|why| refused(grant, &page, Some(&captured), why))?;
        (parsed.title, normalized, None)
    };
    let path = existing
        .map(|f| f.path.clone())
        .unwrap_or_else(|| landing(&folder, &slug(&title)));
    let _landing_receipt = check_target(vault, grant, &path)?;
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let request = plan::Request {
        system: "notion".into(),
        record_id: page.clone(),
        url: Some(format!("https://www.notion.so/{page}")),
        path,
        content: normalized.markdown,
    };
    let planned = plan::plan_with_method(
        &[(0, request)],
        &files,
        &occupied,
        &[],
        &now,
        &grant.actor,
        method,
    )?;
    let result = &planned.imports[0];
    if result.outcome == "kept" {
        return Ok(text_result(format!(
            "{} was edited since its import, so it was kept and nothing was written.",
            result.path
        )));
    }
    if let Some((_, write)) = planned.writes.first() {
        let path = write["path"].as_str().expect("import plan path");
        let by = check_target(vault, grant, path)?;
        vault::write::write_import(
            vault,
            path,
            write["content"].as_str().expect("import bytes"),
            write.get("expectHash").and_then(Value::as_str),
            governed,
            &by,
        )
        .map_err(|error| note_write_refusal(Some(&grant.run_id), TOOL, error))?;
    }
    let mut relinked = 0;
    let mut left = Vec::new();
    let mut left_links = 0;
    let new_links = link_stem(&result.path, &occupied)
        .map(|stem| HashMap::from([(page.clone(), stem)]))
        .unwrap_or_default();
    for ((system, id), citers) in &copies {
        if system != "notion" || id == &page {
            continue;
        }
        for citer in citers {
            if !readable_landing(vault, grant, &citer.path) {
                continue;
            }
            let mut count = 0;
            let (_, old_body) = vault::parse::split_frontmatter(&citer.content);
            let _ = notion::relink(old_body, &new_links, &mut count);
            if count == 0 {
                continue;
            }
            let current = import::stored_import_hash(&citer.content)
                .is_some_and(|stamp| stamp.stored == stamp.current);
            let target = if current {
                check_target(vault, grant, &citer.path).ok()
            } else {
                None
            };
            let Some(by) = target else {
                left_links += count;
                left.push(citer.path.clone());
                continue;
            };
            let Some((bare, url, method)) = unstamp(&citer.content) else {
                left_links += count;
                left.push(citer.path.clone());
                continue;
            };
            let mut linked = 0;
            let (_, body) = vault::parse::split_frontmatter(&bare);
            // Relinking changes prose only. YAML values keep their quoting and
            // structure, even if a property happens to contain a Notion URL.
            let front = &bare[..bare.len() - body.len()];
            let changed = format!("{front}{}", notion::relink(body, &new_links, &mut linked));
            let composed = import::compose(
                &changed,
                &import::Stamp {
                    system: "notion",
                    record_id: id,
                    url: url.as_deref(),
                    method: method.as_deref(),
                    now: &now,
                    actor: &grant.actor,
                },
            );
            let Ok(composed) = composed else {
                left_links += count;
                left.push(citer.path.clone());
                continue;
            };
            let expected = import::hash(&citer.content);
            if vault::write::write_import(
                vault,
                &citer.path,
                &composed.content,
                Some(&expected),
                governed,
                &by,
            )
            .is_ok()
            {
                relinked += 1;
            } else {
                left_links += count;
                left.push(citer.path.clone());
            }
        }
    }
    let mut reply = match result.outcome {
        "unchanged" => format!(
            "{} already holds this page, unchanged since its import.",
            result.path
        ),
        "replaced" => format!(
            "Updated {} from Notion; nobody had edited it since its import.",
            result.path
        ),
        _ => format!("Imported “{title}” from Notion to {}.", result.path),
    };
    for (count,words) in [(normalized.counts.linked,format!("Linked {} pages already imported.",normalized.counts.linked)),(relinked,format!("Relinked {relinked} pages that cite it.")),(left_links,format!("Left {left_links} links as Notion links: those pages were edited since import or are outside this run's reach.")),(normalized.counts.media,format!("{} images and files still point at Notion's storage, whose links expire.",normalized.counts.media)),(normalized.counts.databases,format!("Dropped {} database blocks.",normalized.counts.databases))] {
        if count>0 {reply.push(' ');reply.push_str(&words);}
    }
    left.sort();
    left.dedup();
    for path in left {
        reply.push_str(&format!("\n- {path}"));
    }
    Ok(text_result(reply))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::extract::testdocs::TempDir;
    use crate::vault::testutil::write;

    const A: &str = "11111111111111111111111111111111";
    const B: &str = "22222222222222222222222222222222";
    const NAME: &str = "mcp__notion-toy__notion-fetch";
    fn grant() -> RunGrant {
        let mut grant = RunGrant::unrestricted("process:notion-import");
        grant.run_id = crate::ledger::new_run_id();
        grant
    }
    fn fetch(grant: &RunGrant, page: &str, title: &str, body: &str) -> capture::Lease {
        let lease = capture::arm(&grant.run_id, vec![NAME.into()]).unwrap();
        let handle = lease.handle();
        handle.begin(NAME, "fetch", Some(&json!({"id":page})));
        handle.put("fetch", &format!("<page url=\"https://www.notion.so/{page}\">\n<properties>\n{}\n</properties>\n<content>\n{body}\n</content>\n</page>",json!({"title":title})), false);
        lease
    }
    fn imported(vault: &Path, grant: &RunGrant, page: &str, folder: &str) -> String {
        let answer = call(
            vault,
            json!({"page":page,"folder":folder}).as_object().unwrap(),
            grant,
        )
        .unwrap();
        answer["content"][0]["text"].as_str().unwrap().into()
    }
    fn attempt(vault: &Path, grant: &RunGrant, page: &str, folder: &str) -> String {
        call(
            vault,
            json!({"page":page,"folder":folder}).as_object().unwrap(),
            grant,
        )
        .unwrap_err()
    }
    #[test]
    fn an_import_is_stamped_idempotent_and_never_overwrites_a_persons_edit() {
        let dir = TempDir::new();
        let grant = grant();
        let _lease = fetch(&grant, A, "My page", "First");
        assert_eq!(
            imported(dir.path(), &grant, A, "pages"),
            "Imported “My page” from Notion to pages/my-page.md."
        );
        let original = std::fs::read_to_string(dir.path().join("pages/my-page.md")).unwrap();
        assert!(original.contains("source_system: \"notion\"\n"));
        assert!(original.contains("imported_by: \"process:notion-import\"\n"));
        let digest = import::stored_import_hash(&original).unwrap();
        assert_eq!(digest.stored, digest.current);
        assert_eq!(
            imported(dir.path(), &grant, A, "elsewhere"),
            "pages/my-page.md already holds this page, unchanged since its import."
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("pages/my-page.md")).unwrap(),
            original
        );
        write(
            dir.path(),
            "pages/my-page.md",
            &format!("{original}\nMy edit\n"),
        );
        assert!(imported(dir.path(), &grant, A, "pages")
            .ends_with("was edited since its import, so it was kept and nothing was written."));
        assert!(std::fs::read_to_string(dir.path().join("pages/my-page.md"))
            .unwrap()
            .ends_with("My edit\n"));
    }
    #[test]
    fn a_later_page_relinks_unchanged_citers_and_preserves_their_other_bytes() {
        let dir = TempDir::new();
        let first = grant();
        let _a = fetch(
            &first,
            A,
            "First",
            &format!("[Second](https://www.notion.so/{B})\n\n`[Code](https://www.notion.so/{B})`"),
        );
        imported(dir.path(), &first, A, "pages");
        let second = grant();
        let _b = fetch(&second, B, "Second", "Body");
        let reply = imported(dir.path(), &second, B, "pages");
        assert!(reply.ends_with("Relinked 1 pages that cite it."), "{reply}");
        let a = std::fs::read_to_string(dir.path().join("pages/first.md")).unwrap();
        assert!(a.contains("[[second]]"));
        assert!(a.contains(&format!("`[Code](https://www.notion.so/{B})`")));
        let digest = import::stored_import_hash(&a).unwrap();
        assert_eq!(digest.stored, digest.current);
        assert!(imported(dir.path(), &second, B, "pages").contains("already holds"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("pages/first.md")).unwrap(),
            a
        );
    }
    #[test]
    fn edited_and_unwritable_citers_stay_named_but_unreadable_copies_stay_private() {
        let dir = TempDir::new();
        let first = grant();
        let _a = fetch(
            &first,
            A,
            "First",
            &format!("[Second](https://www.notion.so/{B})"),
        );
        imported(dir.path(), &first, A, "private");
        let original = std::fs::read_to_string(dir.path().join("private/first.md")).unwrap();
        let mut second = grant();
        second.scope = Some(vec!["pages".into()]);
        let _b = fetch(&second, B, "Second", "Body");
        let reply = imported(dir.path(), &second, B, "pages");
        assert!(reply.contains("Left 1 links as Notion links"));
        assert!(reply.ends_with("\n- private/first.md"));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("private/first.md")).unwrap(),
            original
        );
        second.read_scope = Some(vec!["pages".into()]);
        let reply = imported(dir.path(), &second, B, "pages");
        assert!(!reply.contains("private") && !reply.contains("Left"));
        assert_eq!(attempt(dir.path(), &second, A, "pages"), "import_refused: capture_missing — This run has no matching Notion fetch. Fetch this page in this turn first. Nothing was written.");
        let _a = fetch(&second, A, "First", "Body");
        assert_eq!(
            attempt(dir.path(), &second, A, "pages"),
            "This run cannot import that page within its read reach."
        );
        assert!(!dir.path().join("pages/first.md").exists());
    }
    #[test]
    fn an_import_never_takes_page_text_from_the_model_unmarked() {
        let dir = TempDir::new();
        let grant = grant();
        let _lease = fetch(&grant, A, "First", "<unknown>Body</unknown>");
        let body = json!({"page":A,"folder":"pages","body":"# Composed\n\nBody"});
        assert!(call(dir.path(), body.as_object().unwrap(), &grant)
            .unwrap_err()
            .contains("only after"));
        assert!(
            attempt(dir.path(), &grant, A, "pages").starts_with("import_refused: unhandled_markup")
        );
        call(dir.path(), body.as_object().unwrap(), &grant).unwrap();
        let (files, _) = plan::read_vault(dir.path()).unwrap();
        assert_eq!(files.len(), 1);
        assert!(files[0]
            .content
            .contains("import_method: \"agent_composed\"\n"));
        let other = self::grant();
        assert!(
            attempt(dir.path(), &other, A, "pages").starts_with("import_refused: capture_missing")
        );
    }
    #[test]
    fn database_errors_and_guarded_landings_write_nothing() {
        let dir = TempDir::new();
        let grant = grant();
        let lease = capture::arm(&grant.run_id, vec![NAME.into()]).unwrap();
        lease.handle().begin(NAME, "fetch", Some(&json!({"id":A})));
        lease
            .handle()
            .put("fetch", r#"{"object":"database"}"#, false);
        assert!(
            attempt(dir.path(), &grant, A, "pages").starts_with("import_refused: database_first")
        );
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
        let _lease = fetch(&grant, A, "Page", "Body");
        for folder in ["knowledge", "sources", ".hidden", "views", "../outside"] {
            assert!(!attempt(dir.path(), &grant, A, folder).is_empty());
        }
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
        assert!(imported(dir.path(), &grant, A, "").contains("to page.md."));
    }
    #[test]
    fn planned_writes_compare_under_the_path_lock_and_never_replace_an_appeared_file() {
        let dir = TempDir::new();
        let grant = grant();
        let by = check_target(dir.path(), &grant, "pages/a.md").unwrap();
        write(dir.path(), "pages/a.md", "Person's bytes");
        assert!(vault::write::write_import(
            dir.path(),
            "pages/a.md",
            "Imported",
            None,
            governed,
            &by
        )
        .is_err());
        assert!(matches!(
            vault::write::write_import(
                dir.path(),
                "pages/a.md",
                "Imported",
                Some("stale"),
                governed,
                &by
            ),
            Err(vault::write::NoteWriteError::Stale(_))
        ));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("pages/a.md")).unwrap(),
            "Person's bytes"
        );
    }
    #[cfg(unix)]
    #[test]
    fn an_import_cannot_reach_mail_or_sources_through_a_folder_alias() {
        let dir = TempDir::new();
        std::fs::create_dir_all(dir.path().join("sources/mail")).unwrap();
        std::os::unix::fs::symlink("sources/mail", dir.path().join("alias")).unwrap();
        let mut grant = grant();
        let _lease = fetch(&grant, A, "Page", "Body");
        grant.asks.kind = crate::policy::tool_approval::RunKind::Unattended;
        assert_eq!(
            attempt(dir.path(), &grant, A, "alias"),
            "This run cannot import that page within its read reach."
        );
        grant.asks.kind = crate::policy::tool_approval::RunKind::Attended;
        assert!(attempt(dir.path(), &grant, A, "alias").contains("no import lands there"));
        assert!(std::fs::read_dir(dir.path().join("sources/mail"))
            .unwrap()
            .next()
            .is_none());
    }
    #[test]
    fn an_ambiguous_stem_keeps_its_notion_url_instead_of_linking_another_page() {
        let dir = TempDir::new();
        let first = grant();
        let _a = fetch(
            &first,
            A,
            "First",
            &format!("[Second](https://notion.so/{B})"),
        );
        imported(dir.path(), &first, A, "pages");
        write(dir.path(), "elsewhere/second.md", "# An unrelated page");
        let second = grant();
        let _b = fetch(&second, B, "Second", "Body");
        let reply = imported(dir.path(), &second, B, "pages");
        assert!(!reply.contains("Relinked"));
        let unchanged = std::fs::read_to_string(dir.path().join("pages/first.md")).unwrap();
        assert!(unchanged.contains(&format!("https://notion.so/{B}")));
        imported(dir.path(), &first, A, "pages");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("pages/first.md")).unwrap(),
            unchanged
        );
    }
    #[test]
    fn relinking_leaves_yaml_links_quoted_and_properties_unchanged() {
        let content = import::compose(&format!("---\nreference: '[Second](https://www.notion.so/{B})'\n---\n[Second](https://www.notion.so/{B})"), &import::Stamp{system:"notion",record_id:A,url:None,method:None,now:"2026-10-15T00:00:00Z",actor:"process:toy"}).unwrap().content;
        let dir = TempDir::new();
        write(dir.path(), "pages/first.md", &content);
        let grant = grant();
        let _lease = fetch(&grant, B, "Second", "Body");
        imported(dir.path(), &grant, B, "pages");
        let changed = std::fs::read_to_string(dir.path().join("pages/first.md")).unwrap();
        assert!(changed.contains(&format!("reference: '[Second](https://www.notion.so/{B})'")));
        assert!(changed.ends_with("[[second]]"));
    }
}
