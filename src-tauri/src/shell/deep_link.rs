//! Untrusted `cerebro:` links only select pages and places (M65.6).
//! The OS inbox buffers until the webview has installed its listener. Vault
//! ids resolve through a read-only registry; no link opens an arbitrary path.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::OptionalExtension;
use serde::Serialize;
use tauri::{Emitter, Manager, Url};

use crate::runtime;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Link {
    Open {
        path: String,
        vault: Option<String>,
    },
    Go {
        to: String,
        database: Option<String>,
        view: Option<String>,
        vault: Option<String>,
    },
    Refused {
        reason: String,
    },
}

fn refused(reason: impl Into<String>) -> Link {
    Link::Refused {
        reason: reason.into(),
    }
}

fn page_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.chars().any(|c| c.is_control() || c == '\\')
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

pub fn parse(raw: &str) -> Link {
    if raw.len() > 4096 {
        return refused("it is longer than 4096 bytes");
    }
    let Ok(url) = Url::parse(raw) else {
        return refused("it isn't a cerebro link");
    };
    if !url.scheme().eq_ignore_ascii_case("cerebro") || raw.chars().any(char::is_control) {
        return refused("it isn't a cerebro link");
    }
    let authority_has_userinfo = raw.split_once("://").is_some_and(|(_, tail)| {
        tail.split(['/', '?', '#'])
            .next()
            .is_some_and(|authority| authority.contains('@'))
    });
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !matches!(host.as_str(), "open" | "go")
        || !matches!(url.path(), "" | "/")
        || authority_has_userinfo
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return refused("cerebro links open or go, nothing else");
    }
    let mut fields = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if !matches!(key.as_ref(), "path" | "to" | "database" | "view" | "vault") {
            continue;
        }
        if fields.insert(key.to_string(), value.to_string()).is_some() {
            return refused(format!("it names {key} twice"));
        }
    }
    let vault = fields.remove("vault");
    if vault
        .as_ref()
        .is_some_and(|id| id.len() != 32 || !id.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return refused("its vault id is malformed");
    }
    let vault = vault.map(|id| id.to_ascii_lowercase());
    if host == "open" {
        let Some(path) = fields.remove("path").filter(|p| !p.is_empty()) else {
            return refused("it names no page");
        };
        if !page_path(&path) {
            return refused("its page path leaves the vault");
        }
        Link::Open { path, vault }
    } else {
        let Some(to) = fields.remove("to") else {
            return refused("it names no place");
        };
        let database = fields.remove("database");
        let view = fields.remove("view");
        if to.is_empty()
            || to.len() > 64
            || !to.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            || database
                .iter()
                .chain(view.iter())
                .any(|s| s.chars().count() > 200)
        {
            return refused("it names no place");
        }
        Link::Go {
            to,
            database,
            view,
            vault,
        }
    }
}

pub fn latest_link<'a>(urls: impl IntoIterator<Item = &'a str>) -> Option<Link> {
    urls.into_iter()
        .filter(|raw| {
            raw.split_once(':')
                .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case("cerebro"))
        })
        .last()
        .map(parse)
}

#[derive(Default)]
pub struct Inbox {
    pending: Option<Link>,
    taken: bool,
}
impl Inbox {
    pub fn receive(&mut self, link: Link) -> Option<Link> {
        if self.taken {
            Some(link)
        } else {
            self.pending = Some(link);
            None
        }
    }
    pub fn take(&mut self) -> Option<Link> {
        self.taken = true;
        self.pending.take()
    }
}
#[derive(Default)]
pub struct DeepLinkInbox(Mutex<Inbox>);
impl DeepLinkInbox {
    fn with<T>(&self, f: impl FnOnce(&mut Inbox) -> T) -> T {
        f(&mut self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Lookup {
    Found { path: String },
    Unknown,
    Unreadable,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Vault {
    id: String,
    lookup: Lookup,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Delivered {
    Open {
        path: String,
        vault: Option<Vault>,
    },
    Go {
        to: String,
        database: Option<String>,
        view: Option<String>,
        vault: Option<Vault>,
    },
    Refused {
        reason: String,
    },
}

fn lookup(data: &Path, id: &str) -> Lookup {
    let found = runtime::ReadOnly::open(data).and_then(|ro| {
        ro.query_row(
            "SELECT vault_path FROM vault_registry WHERE vault_id = ?1",
            [id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    });
    match found {
        Ok(Some(path)) => Lookup::Found { path },
        Ok(None) => Lookup::Unknown,
        Err(_) => Lookup::Unreadable,
    }
}

fn resolve(link: Link, lookup: impl FnOnce(&str) -> Lookup) -> Delivered {
    let resolve_vault = |id: Option<String>| {
        id.map(|id| Vault {
            lookup: lookup(&id),
            id,
        })
    };
    match link {
        Link::Open { path, vault } => Delivered::Open {
            path,
            vault: resolve_vault(vault),
        },
        Link::Go {
            to,
            database,
            view,
            vault,
        } => Delivered::Go {
            to,
            database,
            view,
            vault: resolve_vault(vault),
        },
        Link::Refused { reason } => Delivered::Refused { reason },
    }
}
fn for_app(app: &tauri::AppHandle, link: Link) -> Delivered {
    resolve(link, |id| {
        crate::config_dir(app).map_or(Lookup::Unreadable, |data| lookup(&data, id))
    })
}

#[cfg(target_os = "macos")]
pub fn received(app: &tauri::AppHandle, urls: &[Url]) {
    let Some(link) = latest_link(urls.iter().map(Url::as_str)) else {
        return;
    };
    let outgoing = app
        .state::<DeepLinkInbox>()
        .with(|inbox| inbox.receive(link));
    if let Some(link) = outgoing {
        if app.emit("cerebro://deep-link", for_app(app, link)).is_err() {
            log::warn!("a deep link could not reach the window");
        }
    }
}

#[tauri::command]
pub fn take_deep_link(
    app: tauri::AppHandle,
    inbox: tauri::State<'_, DeepLinkInbox>,
) -> Option<Delivered> {
    inbox.with(Inbox::take).map(|link| for_app(&app, link))
}

fn build_app_link(vault: &Path, path: &str) -> Result<String, String> {
    if !page_path(path) {
        return Err("its page path leaves the vault".into());
    }
    let id = runtime::scope::derive_vault_id(vault);
    Url::parse_with_params("cerebro://open", [("vault", id.as_str()), ("path", path)])
        .map(String::from)
        .map_err(|_| "it isn't a cerebro link".into())
}
#[tauri::command]
pub fn app_link(vault: String, path: String) -> Result<String, String> {
    build_app_link(Path::new(&vault), &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::testutil;
    use serde_json::json;

    #[test]
    fn parses_the_link_table() {
        for (raw, expected) in [
            (
                "cerebro://open?path=notes%2Fa+b.md#ignored",
                Link::Open {
                    path: "notes/a b.md".into(),
                    vault: None,
                },
            ),
            (
                "CEREBRO://OPEN/?path=a.md&vault=ABCDEF0123456789ABCDEF0123456789&extra=x&extra=y",
                Link::Open {
                    path: "a.md".into(),
                    vault: Some("abcdef0123456789abcdef0123456789".into()),
                },
            ),
            (
                "cerebro://go?to=view&database=Work+item&view=board",
                Link::Go {
                    to: "view".into(),
                    database: Some("Work item".into()),
                    view: Some("board".into()),
                    vault: None,
                },
            ),
            ("https://open?path=a.md", refused("it isn't a cerebro link")),
            ("bad", refused("it isn't a cerebro link")),
            (
                "cerebro://run?path=a.md",
                refused("cerebro links open or go, nothing else"),
            ),
            (
                "cerebro://open/extra?path=a.md",
                refused("cerebro links open or go, nothing else"),
            ),
            (
                "cerebro://@open?path=a.md",
                refused("cerebro links open or go, nothing else"),
            ),
            (
                "cerebro://user@open?path=a.md",
                refused("cerebro links open or go, nothing else"),
            ),
            (
                "cerebro://open:123?path=a.md",
                refused("cerebro links open or go, nothing else"),
            ),
            (
                "cerebro://open?path=a&path=b",
                refused("it names path twice"),
            ),
            (
                "cerebro://go?to=home&vault=a&vault=b",
                refused("it names vault twice"),
            ),
            ("cerebro://open", refused("it names no page")),
            ("cerebro://open?path=", refused("it names no page")),
            (
                "cerebro://open?path=%2Foutside.md",
                refused("its page path leaves the vault"),
            ),
            (
                "cerebro://open?path=notes%2F..%2Fa.md",
                refused("its page path leaves the vault"),
            ),
            (
                "cerebro://open?path=.%2Fa.md",
                refused("its page path leaves the vault"),
            ),
            (
                "cerebro://open?path=a%2F%2Fb.md",
                refused("its page path leaves the vault"),
            ),
            (
                "cerebro://open?path=a%5Cb.md",
                refused("its page path leaves the vault"),
            ),
            (
                "cerebro://open?path=a%00b.md",
                refused("its page path leaves the vault"),
            ),
            (
                "cerebro://open?path=a%0Ab.md",
                refused("its page path leaves the vault"),
            ),
            (
                "cerebro://open?path=a&vault=not-a-path",
                refused("its vault id is malformed"),
            ),
            ("cerebro://go", refused("it names no place")),
            ("cerebro://go?to=Home", refused("it names no place")),
            ("cerebro://go?to=run-agent", refused("it names no place")),
        ] {
            assert_eq!(parse(raw), expected, "{raw}");
        }
        assert_eq!(
            parse(&format!("cerebro://open?path={}", "a".repeat(1025))),
            refused("its page path leaves the vault")
        );
        assert_eq!(
            parse(&format!("cerebro://go?to=home&view={}", "é".repeat(201))),
            refused("it names no place")
        );
        assert_eq!(
            parse(&format!("cerebro://open?x={}", "x".repeat(4096))),
            refused("it is longer than 4096 bytes")
        );
    }
    #[test]
    fn only_the_last_cerebro_url_counts() {
        assert_eq!(
            latest_link([
                "cerebro://go?to=home",
                "https://example.test",
                "cerebro://go?to=history"
            ]),
            Some(parse("cerebro://go?to=history"))
        );
        assert_eq!(
            latest_link(["cerebro://go?to=home", "CEREBRO://nope"]),
            Some(refused("cerebro links open or go, nothing else"))
        );
        assert_eq!(latest_link(["https://example.test"]), None);
    }
    #[test]
    fn a_link_before_the_take_waits_and_the_latest_wins() {
        let mut inbox = Inbox::default();
        assert_eq!(inbox.receive(parse("cerebro://go?to=home")), None);
        assert_eq!(inbox.receive(parse("cerebro://go?to=history")), None);
        assert_eq!(inbox.take(), Some(parse("cerebro://go?to=history")));
    }
    #[test]
    fn the_take_hands_over_once() {
        let mut inbox = Inbox::default();
        inbox.receive(parse("cerebro://go?to=home"));
        assert!(inbox.take().is_some());
        assert_eq!(inbox.take(), None);
    }
    #[test]
    fn after_the_take_links_go_out_at_once() {
        let mut inbox = Inbox::default();
        assert_eq!(inbox.take(), None);
        let link = parse("cerebro://go?to=history");
        assert_eq!(inbox.receive(link.clone()), Some(link));
        assert_eq!(inbox.take(), None);
    }
    #[test]
    fn a_poisoned_inbox_still_answers() {
        let inbox = DeepLinkInbox::default();
        let _ = std::panic::catch_unwind(|| {
            inbox.with(|state| {
                state.receive(parse("cerebro://go?to=history"));
                panic!("poison the inbox");
            })
        });
        assert_eq!(
            inbox.with(Inbox::take),
            Some(parse("cerebro://go?to=history"))
        );
    }
    #[test]
    fn an_app_link_parses_back_to_its_page_and_vault() {
        let dir = testutil::temp_vault("app-link");
        let path = "notes/a & b + café #?.md";
        let link = build_app_link(&dir, path).unwrap();
        assert_eq!(
            parse(&link),
            Link::Open {
                path: path.into(),
                vault: Some(runtime::scope::derive_vault_id(&dir))
            }
        );
        assert!(build_app_link(&dir, "../outside.md").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn a_vault_id_resolves_only_through_the_registry() {
        let dir = testutil::temp_vault("deep-link-registry");
        assert_eq!(lookup(&dir, &"a".repeat(32)), Lookup::Unreadable);
        assert!(
            !runtime::runtime_db_path(&dir).exists(),
            "a link never initializes the runtime"
        );
        let conn = runtime::open(&dir).unwrap();
        let id = runtime::scope::register(&conn, &dir).unwrap();
        assert_eq!(
            lookup(&dir, &id),
            Lookup::Found {
                path: runtime::scope::canonical_path(&dir)
            }
        );
        assert_eq!(lookup(&dir, &"a".repeat(32)), Lookup::Unknown);
        drop(conn);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn delivered_links_serialize_as_the_shared_payloads() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../fixtures/deep-link-payloads.json")).unwrap();
        let payloads = vec![
            resolve(parse("cerebro://open?path=notes/a.md"), |_| unreachable!()),
            resolve(parse("cerebro://go?to=history"), |_| unreachable!()),
            resolve(refused("it names no page"), |_| unreachable!()),
            resolve(
                parse("cerebro://open?path=notes/a.md&vault=00000000000000000000000000000000"),
                |_| Lookup::Found {
                    path: "/example-vault".into(),
                },
            ),
            resolve(
                parse("cerebro://open?path=notes/a.md&vault=00000000000000000000000000000000"),
                |_| Lookup::Unknown,
            ),
            resolve(
                parse("cerebro://open?path=notes/a.md&vault=00000000000000000000000000000000"),
                |_| Lookup::Unreadable,
            ),
        ];
        assert_eq!(json!(payloads), cases["payloads"]);
    }
}
