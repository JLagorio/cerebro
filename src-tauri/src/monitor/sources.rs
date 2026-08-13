//! The Source Monitor (M26.7d) — what is due, and what actually changed.
//!
//! **It never fetches, and that is architectural rather than unfinished.**
//! Nothing in this process makes a network request; there is no HTTP client
//! in the crate, and adding one would put an egress surface and a credential
//! store inside the deterministic core. Fetching is the assistant's, through
//! the owner's own MCP connectors, under the owner's own credentials. What
//! this module does is decide WHICH cached copies are worth refetching and,
//! afterwards, whether the refetch actually brought anything back.
//!
//! **It is deliberately NOT a Scout.** A Scout notices genuinely novel
//! patterns, which is a model capability and a later milestone. This compares
//! hashes.
//!
//! **The content hash excludes the fetch bookkeeping, and that is the whole
//! trick.** `cache_source` stamps `fetched_at` and `generated.at` on every
//! write, so a refetch that returned byte-identical content still rewrites
//! the file. A monitor that hashed the file would report a change every
//! single time it checked — which is the same as never checking, except more
//! expensive. So the hash covers what the SOURCE said (its identity, its
//! link, its title, its body) and nothing about when we last asked.
//!
//! **Staleness is a date the owner or the agent set, not a policy this
//! module invents.** A cached copy with no `stale_after` is never due: an
//! absent date means nobody said it expires, and inventing a default here
//! would silently put every source in the base on a refresh schedule.

use crate::ledger::sha256_hex;
use crate::vault::entry::Entry;

/// The rules version, so a stored row can be read against the computation
/// that produced it.
pub const MONITOR_VERSION: &str = "source-monitor-v1";

/// The `type:` a cached copy carries.
pub const SOURCE_TYPE: &str = "Source";

/// Snapshot fields that describe the FETCH rather than the source. Removed
/// before hashing — see the module note.
const FETCH_BOOKKEEPING: [&str; 3] = [
    "properties.fetched_at",
    "properties.stale_after",
    "properties.generated",
];

/// One cached copy, as the monitor sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cached {
    /// Vault-relative path — the same key the ingest scheduler uses.
    pub item_key: String,
    /// The upstream's own id, as `cache_source` recorded it.
    pub source_id: String,
    pub source_kind: Option<String>,
    pub source_url: Option<String>,
    /// What the source SAID, hashed. Independent of when we last asked.
    pub content_hash: String,
    pub fetched_at: Option<String>,
    /// The date after which the copy should be refetched. `None` means
    /// nobody said it expires.
    pub stale_after: Option<String>,
}

/// Hash what the source said.
///
/// Built from the M25 normalized snapshot with the fetch bookkeeping removed,
/// plus the body — the snapshot deliberately omits the body (it carries only a
/// derived `snippet`, which it also omits), and a cached copy whose text
/// changed under identical frontmatter is exactly the change worth catching.
pub fn content_hash(entry: &Entry, body: &str) -> Result<String, String> {
    let mut snapshot = crate::runtime::normalize::snapshot(entry);
    for field in FETCH_BOOKKEEPING {
        snapshot.fields.remove(field);
    }
    Ok(sha256_hex(
        format!(
            "cerebro-source-content-v1\0{}\0{}",
            snapshot.canonical()?,
            body.trim_end()
        )
        .as_bytes(),
    ))
}

fn string_property(entry: &Entry, key: &str) -> Option<String> {
    entry
        .properties
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::to_string)
}

/// Read one entry as a cached copy, or `None` if it is not one.
///
/// A `Source` note with no `source_id` is not a cached copy of anything — it
/// is a file somebody typed the type into — and monitoring it would mean
/// inventing an identity for a source nobody named.
pub fn cached(entry: &Entry, body: &str) -> Result<Option<Cached>, String> {
    if entry.entry_type.as_deref() != Some(SOURCE_TYPE) {
        return Ok(None);
    }
    let Some(source_id) = string_property(entry, "source_id") else {
        return Ok(None);
    };
    Ok(Some(Cached {
        item_key: entry.path.clone(),
        source_id,
        source_kind: string_property(entry, "source_kind"),
        source_url: string_property(entry, "source_url"),
        content_hash: content_hash(entry, body)?,
        fetched_at: string_property(entry, "fetched_at"),
        stale_after: string_property(entry, "stale_after"),
    }))
}

/// Whether a copy is worth asking about again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Freshness {
    /// Nobody said it expires.
    NeverExpires,
    Fresh,
    /// `stale_after` has passed. The date is carried so a surface can say
    /// how long, without recomputing it from a clock of its own.
    Due {
        since: String,
    },
}

/// Is this copy due, on `today` (a `YYYY-MM-DD` local date)?
///
/// `stale_after` is an ABSOLUTE date, exactly as `okf.ts` reads it, so this
/// is a string comparison and not a duration. An unparseable date is treated
/// as never expiring rather than as due: a malformed field is a reason to
/// leave a copy alone, not a reason to spend a fetch on it.
pub fn freshness(cached: &Cached, today: &str) -> Freshness {
    let Some(stale_after) = cached.stale_after.as_deref() else {
        return Freshness::NeverExpires;
    };
    if !is_iso_date(stale_after) {
        return Freshness::NeverExpires;
    }
    if stale_after < today {
        Freshness::Due {
            since: stale_after.to_string(),
        }
    } else {
        Freshness::Fresh
    }
}

fn is_iso_date(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes()[4] == b'-'
        && value.as_bytes()[7] == b'-'
        && value
            .bytes()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
}

/// What a check found, compared with what was last recorded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// The monitor had never seen this copy.
    FirstSeen,
    /// Same content. A refetch that landed here cost a request and produced
    /// no ingest work, which is the outcome the whole hash exists for.
    Unchanged,
    Changed {
        from: String,
    },
}

/// Compare a current copy against the hash last recorded for it.
pub fn compare(previous: Option<&str>, current: &Cached) -> Change {
    match previous {
        None => Change::FirstSeen,
        Some(hash) if hash == current.content_hash => Change::Unchanged,
        Some(hash) => Change::Changed {
            from: hash.to_string(),
        },
    }
}

/// Does this change create ingest work?
///
/// Only a changed hash does. `FirstSeen` does NOT: the ordinary way a copy is
/// first seen is that the ingest scanner just wrote it, and creating work for
/// bytes the scanner is already carrying would double-process every new
/// source.
pub fn creates_work(change: &Change) -> bool {
    matches!(change, Change::Changed { .. })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str, stale_after: Option<&str>, fetched_at: &str) -> Entry {
        let mut entry = Entry::empty_for_test("sources/web-alpha.md");
        entry.title = "Alpha".into();
        entry.entry_type = Some(SOURCE_TYPE.into());
        entry
            .properties
            .insert("source_id".into(), serde_json::json!(id));
        entry
            .properties
            .insert("source_kind".into(), serde_json::json!("web"));
        entry.properties.insert(
            "source_url".into(),
            serde_json::json!("https://example.test/a"),
        );
        entry
            .properties
            .insert("fetched_at".into(), serde_json::json!(fetched_at));
        entry.properties.insert(
            "generated".into(),
            serde_json::json!({ "by": "agent:x", "at": fetched_at }),
        );
        if let Some(stale_after) = stale_after {
            entry
                .properties
                .insert("stale_after".into(), serde_json::json!(stale_after));
        }
        entry
    }

    #[test]
    fn refetching_identical_content_is_not_a_change() {
        // The defect this module exists to avoid: `cache_source` restamps
        // `fetched_at` and `generated.at` on every write, so a monitor that
        // hashed the file would report a change every time it checked.
        let before = source("web:alpha", Some("2026-09-01"), "2026-08-01T00:00:00Z");
        let after = source("web:alpha", Some("2026-10-01"), "2026-08-12T00:00:00Z");
        let body = "# Alpha\n\nThe upstream text.\n";
        assert_eq!(
            content_hash(&before, body).unwrap(),
            content_hash(&after, body).unwrap()
        );
    }

    #[test]
    fn a_body_that_changed_under_identical_frontmatter_is_a_change() {
        // The normalized snapshot carries no body at all, so a monitor built
        // on it alone would call this unchanged.
        let entry = source("web:alpha", Some("2026-09-01"), "2026-08-01T00:00:00Z");
        assert_ne!(
            content_hash(&entry, "# Alpha\n\nOne.\n").unwrap(),
            content_hash(&entry, "# Alpha\n\nTwo.\n").unwrap()
        );
    }

    #[test]
    fn a_moved_link_is_a_change_even_when_the_text_is_the_same() {
        let mut moved = source("web:alpha", Some("2026-09-01"), "2026-08-01T00:00:00Z");
        moved.properties.insert(
            "source_url".into(),
            serde_json::json!("https://example.test/b"),
        );
        let body = "# Alpha\n\nThe upstream text.\n";
        assert_ne!(
            content_hash(
                &source("web:alpha", Some("2026-09-01"), "2026-08-01T00:00:00Z"),
                body
            )
            .unwrap(),
            content_hash(&moved, body).unwrap()
        );
    }

    #[test]
    fn only_a_source_with_an_id_is_a_cached_copy() {
        let body = "# Alpha\n\nText.\n";
        let mut plain = Entry::empty_for_test("records/a.md");
        plain.entry_type = Some("Person".into());
        assert_eq!(cached(&plain, body).unwrap(), None);

        let mut typed = Entry::empty_for_test("sources/mystery.md");
        typed.entry_type = Some(SOURCE_TYPE.into());
        assert_eq!(
            cached(&typed, body).unwrap(),
            None,
            "a Source with no source_id is a file somebody typed the type into"
        );

        let real = source("web:alpha", Some("2026-09-01"), "2026-08-01T00:00:00Z");
        let read = cached(&real, body).unwrap().expect("a cached copy");
        assert_eq!(read.source_id, "web:alpha");
        assert_eq!(read.source_url.as_deref(), Some("https://example.test/a"));
    }

    #[test]
    fn nobody_said_it_expires_means_it_never_does() {
        // Not an oversight to be defaulted away: inventing a default here
        // would put every source in the base on a refresh schedule the owner
        // never asked for.
        let body = "# Alpha\n\nText.\n";
        let copy = cached(&source("web:alpha", None, "2020-01-01T00:00:00Z"), body)
            .unwrap()
            .unwrap();
        assert_eq!(freshness(&copy, "2026-08-12"), Freshness::NeverExpires);
    }

    #[test]
    fn a_malformed_date_leaves_the_copy_alone() {
        let body = "# Alpha\n\nText.\n";
        let copy = cached(
            &source("web:alpha", Some("soonish"), "2020-01-01T00:00:00Z"),
            body,
        )
        .unwrap()
        .unwrap();
        assert_eq!(freshness(&copy, "2026-08-12"), Freshness::NeverExpires);
    }

    #[test]
    fn due_is_strictly_after_the_date_and_carries_it() {
        let body = "# Alpha\n\nText.\n";
        let copy = cached(
            &source("web:alpha", Some("2026-08-12"), "2020-01-01T00:00:00Z"),
            body,
        )
        .unwrap()
        .unwrap();
        assert_eq!(freshness(&copy, "2026-08-12"), Freshness::Fresh);
        assert_eq!(
            freshness(&copy, "2026-08-13"),
            Freshness::Due {
                since: "2026-08-12".into()
            }
        );
    }

    #[test]
    fn only_a_changed_hash_creates_ingest_work() {
        let body = "# Alpha\n\nText.\n";
        let copy = cached(
            &source("web:alpha", Some("2026-09-01"), "2026-08-01T00:00:00Z"),
            body,
        )
        .unwrap()
        .unwrap();
        assert_eq!(compare(None, &copy), Change::FirstSeen);
        assert!(
            !creates_work(&Change::FirstSeen),
            "the scanner is already carrying the bytes that made this row"
        );
        assert_eq!(compare(Some(&copy.content_hash), &copy), Change::Unchanged);
        assert!(!creates_work(&Change::Unchanged));
        let changed = compare(Some("f".repeat(64).as_str()), &copy);
        assert!(creates_work(&changed));
    }
}
