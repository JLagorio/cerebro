//! The date grammar every stored date property is read and written by
//! (M60.3): `shared/calendar/dates.v1.json`, which
//! `src/engine/dateGrammar.ts` reads too. Neither language holds the rule;
//! both interpret the same file and replay its `cases`, so a disagreement is
//! a failing case rather than a review comment (D3).
//!
//! Three forms: a floating day (`2026-07-28`), a floating day and wall time
//! (`2026-07-28 14:30`, or a `T`), and an instant (`2026-07-28T09:20:00Z`,
//! what `mcp.rs` and the scanner write). Floating values mean the same thing
//! in every zone; an instant reads as the wall time in the zone the caller
//! passes. Reads are lenient (trimmed, and an unreadable end is an open
//! range); writes are strict (exact text, and a range never runs backwards
//! or ends without starting).
//!
//! Nothing here reads the clock: a zone is always an argument.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::Deserialize;
use serde_json::Value;

/// The grammar, bound at compile time.
pub const DATES_JSON: &str = include_str!("../../../shared/calendar/dates.v1.json");

/// The committed SHA-256 of those bytes, checked when the grammar loads.
/// Regenerate it deliberately after an edit (see `write_dates_digest`).
pub const DATES_DIGEST: &str = include_str!("../../../shared/calendar/dates.v1.sha256");

/// Repo-relative locations, for the tests that read the files on disk.
pub const DATES_PATH: &str = "shared/calendar/dates.v1.json";
pub const DATES_DIGEST_PATH: &str = "shared/calendar/dates.v1.sha256";

/// The format this build reads.
pub const FORMAT: u64 = 1;

const FORMS: [&str; 3] = ["date", "date_time", "instant"];
const ZONES: [&str; 3] = ["Z", "+HH:MM", "-HH:MM"];

#[derive(Debug, Clone, Deserialize)]
struct DateTimeRule {
    seconds: String,
}

#[derive(Debug, Clone, Deserialize)]
struct FractionDigits {
    min: usize,
    max: usize,
}

#[derive(Debug, Clone, Deserialize)]
struct InstantRule {
    seconds: String,
    fraction_digits: FractionDigits,
    zones: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RelativeDay {
    token: String,
    offset: i32,
    words: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RelativePeriod {
    token: String,
    unit: String,
    offset: i32,
    words: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RelativeOffsets {
    prefix: String,
    signs: BTreeMap<String, i32>,
    min: u32,
    max: u32,
    leading_zero: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct RelativeGrammar {
    days: Vec<RelativeDay>,
    offsets: RelativeOffsets,
    periods: Vec<RelativePeriod>,
    week_starts: Vec<u32>,
    words: BTreeMap<String, String>,
}

fn check_relative(rule: &RelativeGrammar) -> Result<(), String> {
    let mut tokens = Vec::new();
    if rule.days.is_empty() || rule.periods.is_empty() {
        return Err("dates: relative tokens must be non-empty and unique".into());
    }
    for (token, words) in rule
        .days
        .iter()
        .map(|d| (&d.token, &d.words))
        .chain(rule.periods.iter().map(|p| (&p.token, &p.words)))
    {
        if token.is_empty() || words.is_empty() || tokens.contains(token) {
            return Err("dates: relative tokens must be non-empty and unique".into());
        }
        tokens.push(token.clone());
    }
    let offsets = &rule.offsets;
    if offsets.prefix.is_empty()
        || offsets.min != 1
        || offsets.max != 999
        || offsets.signs != BTreeMap::from([("+".into(), 1), ("-".into(), -1)])
        || offsets.leading_zero
    {
        return Err("dates: relative offsets are invalid".into());
    }
    for period in &rule.periods {
        word("relative period unit", &period.unit, &["week", "month"])?;
        if !(-1..=1).contains(&period.offset) {
            return Err("dates: relative offsets are invalid".into());
        }
    }
    if rule.week_starts != [0, 1] {
        return Err("dates: relative week_starts must be 0, 1 in order".into());
    }
    for key in ["past_one", "past_many", "future_one", "future_many"] {
        if !rule
            .words
            .get(key)
            .is_some_and(|words| words.contains("{n}"))
        {
            return Err("dates: relative words must name {n}".into());
        }
    }
    Ok(())
}

/// The loaded grammar. `cases` stay `Value`s: only the tests replay them.
#[derive(Debug, Clone, Deserialize)]
pub struct Grammar {
    pub format: u64,
    pub artifact_version: u64,
    pub rule_version: String,
    forms: Vec<String>,
    time_separators: Vec<String>,
    written_separator: String,
    date_time: DateTimeRule,
    instant: InstantRule,
    calendar: String,
    read: String,
    write: String,
    backwards: String,
    relative: RelativeGrammar,
    pub relative_cases: Vec<Value>,
    pub cases: Vec<Value>,
}

impl Grammar {
    fn has_form(&self, form: &str) -> bool {
        self.forms.iter().any(|f| f == form)
    }

    fn is_separator(&self, c: u8) -> bool {
        self.time_separators.iter().any(|s| s.as_bytes() == [c])
    }

    /// The separator a write puts between a day and its time.
    pub fn written_separator(&self) -> &str {
        &self.written_separator
    }
}

fn word(key: &str, got: &str, known: &[&str]) -> Result<(), String> {
    if known.contains(&got) {
        Ok(())
    } else {
        Err(format!("dates: {key} has an unknown word {got}"))
    }
}

/// Parse and check a grammar, refusing in the words `dateGrammar.ts` uses.
pub fn parse_grammar(raw: &str) -> Result<Grammar, String> {
    // Validate this section's shape separately so both readers refuse a
    // missing or malformed section in the same words, not serde's wording.
    let value: Value = serde_json::from_str(raw).map_err(|e| format!("dates: {e}"))?;
    let relative: RelativeGrammar = serde_json::from_value(value["relative"].clone())
        .map_err(|_| "dates: relative has an invalid shape".to_string())?;
    check_relative(&relative)?;
    let g: Grammar = serde_json::from_str(raw).map_err(|e| format!("dates: {e}"))?;
    if g.format != FORMAT {
        return Err(format!("dates: format must be {FORMAT}, not {}", g.format));
    }
    if g.rule_version.trim().is_empty() {
        return Err("dates: rule_version is empty".into());
    }
    for form in &g.forms {
        if !FORMS.contains(&form.as_str()) {
            return Err(format!("dates: unknown form {form}"));
        }
    }
    if g.time_separators.is_empty() {
        return Err("dates: time_separators is empty".into());
    }
    for sep in &g.time_separators {
        if sep.len() != 1 || !sep.is_ascii() {
            return Err(format!(
                "dates: time separator {sep:?} is not one character"
            ));
        }
    }
    if !g.time_separators.contains(&g.written_separator) {
        return Err("dates: written_separator is not a time separator".into());
    }
    word("date_time.seconds", &g.date_time.seconds, &["never"])?;
    word(
        "instant.seconds",
        &g.instant.seconds,
        &["optional", "required"],
    )?;
    for zone in &g.instant.zones {
        word("instant.zones", zone, &ZONES)?;
    }
    let digits = &g.instant.fraction_digits;
    if digits.min == 0 || digits.min > digits.max || digits.max > 9 {
        return Err("dates: instant.fraction_digits must run from 1 to at most 9".into());
    }
    word("calendar", &g.calendar, &["proleptic_gregorian"])?;
    word("read", &g.read, &["lenient"])?;
    word("write", &g.write, &["strict"])?;
    word("backwards", &g.backwards, &["same_form"])?;
    if g.cases.is_empty() {
        return Err("dates: no cases".into());
    }
    if g.relative_cases.is_empty() {
        return Err("dates: no relative cases".into());
    }
    Ok(g)
}

/// The compiled-in grammar, checked against its digest once.
pub fn grammar() -> Result<&'static Grammar, String> {
    static LOADED: OnceLock<Result<Grammar, String>> = OnceLock::new();
    LOADED
        .get_or_init(|| {
            if crate::ledger::sha256_hex(DATES_JSON.as_bytes()) != DATES_DIGEST.trim() {
                return Err(format!(
                    "dates: the compiled bytes do not match {DATES_DIGEST_PATH}"
                ));
            }
            parse_grammar(DATES_JSON)
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// A relative token resolves to inclusive calendar days on the caller's
/// clock. Query evaluation passes its injected day here (M62.2).
pub fn resolve_relative(
    text: &str,
    today: NaiveDate,
    week_start: u32,
) -> Option<(NaiveDate, NaiveDate)> {
    let rule = &grammar().ok()?.relative;
    if !rule.week_starts.contains(&week_start) {
        return None;
    }
    let text = text.trim();
    let shifted = |days: i64| today.checked_add_signed(Duration::days(days));
    let range = if let Some(day) = rule.days.iter().find(|day| day.token == text) {
        let date = shifted(i64::from(day.offset))?;
        (date, date)
    } else if let Some(period) = rule.periods.iter().find(|period| period.token == text) {
        if period.unit == "week" {
            let back = (today.weekday().num_days_from_sunday() + 7 - week_start) % 7;
            let start = shifted(i64::from(period.offset) * 7 - i64::from(back))?;
            (start, start.checked_add_signed(Duration::days(6))?)
        } else {
            let month = today.year() * 12 + today.month0() as i32 + period.offset;
            let first = |n: i32| {
                NaiveDate::from_ymd_opt(n.div_euclid(12), (n.rem_euclid(12) + 1) as u32, 1)
            };
            (first(month)?, first(month + 1)?.pred_opt()?)
        }
    } else {
        let suffix = text.strip_prefix(&rule.offsets.prefix)?;
        let (sign, number) = suffix.split_at_checked(1)?;
        let direction = *rule.offsets.signs.get(sign)?;
        if number.is_empty()
            || !number.bytes().all(|c| c.is_ascii_digit())
            || (!rule.offsets.leading_zero && number.starts_with('0'))
        {
            return None;
        }
        let count: u32 = number.parse().ok()?;
        if !(rule.offsets.min..=rule.offsets.max).contains(&count) {
            return None;
        }
        let date = shifted(i64::from(count) * i64::from(direction))?;
        (date, date)
    };
    ((0..=9999).contains(&range.0.year()) && (0..=9999).contains(&range.1.year())).then_some(range)
}

/// One endpoint as a reader sees it: a day, an optional wall time (`HH:MM`),
/// and whether it was written as an instant (then both are local to the zone
/// it was read in).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Endpoint {
    pub date: NaiveDate,
    pub time: Option<NaiveTime>,
    pub instant: bool,
}

/// A date value read leniently: a scalar has no end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateRead {
    pub start: Endpoint,
    pub end: Option<Endpoint>,
}

/// Why a range may not be written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeFault {
    /// Not a `{start, end}` mapping.
    Shape,
    /// An endpoint that is not date text, or an end with no start.
    Endpoint,
    /// The end comes before the start.
    Backwards,
}

/// Exactly what the text says, before any zone is applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Parsed {
    Floating {
        date: NaiveDate,
        time: Option<NaiveTime>,
    },
    /// The UTC moment, kept to the nanosecond for comparison.
    Instant { utc: NaiveDateTime },
}

fn digits(bytes: &[u8], at: usize, len: usize) -> Option<u32> {
    let slice = bytes.get(at..at + len)?;
    let mut n = 0u32;
    for &b in slice {
        if !b.is_ascii_digit() {
            return None;
        }
        n = n * 10 + u32::from(b - b'0');
    }
    Some(n)
}

/// Strict: the whole text must be one form the grammar admits.
fn parse_exact(text: &str, g: &Grammar) -> Option<Parsed> {
    let b = text.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let year = digits(b, 0, 4)?;
    let month = digits(b, 5, 2)?;
    let day = digits(b, 8, 2)?;
    let date = NaiveDate::from_ymd_opt(i32::try_from(year).ok()?, month, day)?;
    if b.len() == 10 {
        return g
            .has_form("date")
            .then_some(Parsed::Floating { date, time: None });
    }
    if !g.is_separator(b[10]) || b.get(13) != Some(&b':') {
        return None;
    }
    let hour = digits(b, 11, 2)?;
    let minute = digits(b, 14, 2)?;
    if hour > 23 || minute > 59 {
        return None;
    }
    if b.len() == 16 {
        let time = NaiveTime::from_hms_opt(hour, minute, 0)?;
        return g.has_form("date_time").then_some(Parsed::Floating {
            date,
            time: Some(time),
        });
    }
    if !g.has_form("instant") {
        return None;
    }
    let mut at = 16;
    let mut second = 0;
    let mut nanos = 0;
    if b[at] == b':' {
        second = digits(b, at + 1, 2)?;
        if second > 59 {
            return None;
        }
        at += 3;
        if b.get(at) == Some(&b'.') {
            let start = at + 1;
            let mut end = start;
            while end < b.len() && b[end].is_ascii_digit() {
                end += 1;
            }
            let count = end - start;
            let rule = &g.instant.fraction_digits;
            if count < rule.min || count > rule.max {
                return None;
            }
            let mut n = digits(b, start, count)?;
            for _ in count..9 {
                n *= 10;
            }
            nanos = n;
            at = end;
        }
    } else if g.instant.seconds == "required" {
        return None;
    }
    let zone = &b[at..];
    let offset_seconds: i64 = if zone == b"Z" {
        if !g.instant.zones.iter().any(|z| z == "Z") {
            return None;
        }
        0
    } else {
        if zone.len() != 6 || zone[3] != b':' {
            return None;
        }
        let sign = match zone[0] {
            b'+' if g.instant.zones.iter().any(|z| z == "+HH:MM") => 1,
            b'-' if g.instant.zones.iter().any(|z| z == "-HH:MM") => -1,
            _ => return None,
        };
        let oh = digits(zone, 1, 2)?;
        let om = digits(zone, 4, 2)?;
        if oh > 23 || om > 59 {
            return None;
        }
        sign * i64::from(oh * 3600 + om * 60)
    };
    let wall = date.and_time(NaiveTime::from_hms_nano_opt(hour, minute, second, nanos)?);
    let utc = wall.checked_sub_signed(Duration::seconds(offset_seconds))?;
    Some(Parsed::Instant { utc })
}

fn parse_with(text: &str) -> Option<Parsed> {
    grammar().ok().and_then(|g| parse_exact(text, g))
}

fn to_endpoint(parsed: Parsed, tz: &Tz) -> Endpoint {
    match parsed {
        Parsed::Floating { date, time } => Endpoint {
            date,
            time,
            instant: false,
        },
        Parsed::Instant { utc } => {
            let local = Utc.from_utc_datetime(&utc).with_timezone(tz).naive_local();
            let time = NaiveTime::from_hms_opt(
                chrono::Timelike::hour(&local),
                chrono::Timelike::minute(&local),
                0,
            );
            Endpoint {
                date: local.date(),
                time,
                instant: true,
            }
        }
    }
}

/// Lenient: one endpoint out of text that may carry padding. An instant
/// reads as its wall time in `tz`.
pub fn parse_date_text(text: &str, tz: &Tz) -> Option<Endpoint> {
    parse_with(text.trim()).map(|p| to_endpoint(p, tz))
}

/// Strict: a string that is exactly date text, as a write must store it.
pub fn is_date_text(value: &Value) -> bool {
    value.as_str().and_then(parse_with).is_some()
}

/// Lenient: a stored `date` or `daterange` value, or None when it holds no
/// readable start. A junk end reads as an open range; a backwards range reads
/// as written.
pub fn read_date_value(value: &Value, tz: &Tz) -> Option<DateRead> {
    if let Some(text) = value.as_str() {
        return parse_date_text(text, tz).map(|start| DateRead { start, end: None });
    }
    let map = value.as_object()?;
    let start = map.get("start")?.as_str()?;
    let start = parse_date_text(start, tz)?;
    let end = map
        .get("end")
        .and_then(Value::as_str)
        .and_then(|text| parse_date_text(text, tz));
    Some(DateRead { start, end })
}

/// The `same_form` rule: two instants compare as moments; two floating
/// values by day, then by time only when both have one; mixed forms are not
/// compared.
fn runs_backwards(start: Parsed, end: Parsed) -> bool {
    match (start, end) {
        (Parsed::Instant { utc: a }, Parsed::Instant { utc: b }) => b < a,
        (Parsed::Floating { date: da, time: ta }, Parsed::Floating { date: db, time: tb }) => {
            match db.cmp(&da) {
                std::cmp::Ordering::Less => true,
                std::cmp::Ordering::Greater => false,
                std::cmp::Ordering::Equal => matches!((ta, tb), (Some(a), Some(b)) if b < a),
            }
        }
        _ => false,
    }
}

/// Strict: why a `daterange` value may not be written, or None when it may.
pub fn range_fault(value: &Value) -> Option<RangeFault> {
    let Some(map) = value.as_object() else {
        return Some(RangeFault::Shape);
    };
    let endpoint = |key: &str| -> Result<Option<Parsed>, RangeFault> {
        match map.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(text)) => parse_with(text).map(Some).ok_or(RangeFault::Endpoint),
            Some(_) => Err(RangeFault::Endpoint),
        }
    };
    let start = match endpoint("start") {
        Ok(p) => p,
        Err(fault) => return Some(fault),
    };
    let end = match endpoint("end") {
        Ok(p) => p,
        Err(fault) => return Some(fault),
    };
    match (start, end) {
        (None, Some(_)) => Some(RangeFault::Endpoint),
        (Some(s), Some(e)) if runs_backwards(s, e) => Some(RangeFault::Backwards),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::str::FromStr;

    fn repo(rel: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(rel)
    }

    #[test]
    fn the_loaded_bytes_match_the_committed_digest() {
        let committed = std::fs::read_to_string(repo(DATES_DIGEST_PATH))
            .expect("read the committed date-grammar digest")
            .trim()
            .to_string();
        assert_eq!(
            crate::ledger::sha256_hex(DATES_JSON.as_bytes()),
            committed,
            "the grammar changed without regenerating {DATES_DIGEST_PATH} — run \
             `cargo test --lib vault::dates::tests::write_dates_digest -- --ignored`"
        );
        let disk = std::fs::read_to_string(repo(DATES_PATH)).expect("read the date grammar");
        assert_eq!(disk, DATES_JSON, "a stale build: recompile");
        grammar().expect("the shipped grammar loads");
    }

    /// Re-stamp the digest after a deliberate grammar edit.
    #[test]
    #[ignore = "run explicitly after a deliberate date-grammar edit"]
    fn write_dates_digest() {
        let digest = crate::ledger::sha256_hex(DATES_JSON.as_bytes());
        std::fs::write(repo(DATES_DIGEST_PATH), format!("{digest}\n")).unwrap();
    }

    fn endpoint_json(e: &Endpoint) -> Value {
        json!({
            "date": e.date.format("%Y-%m-%d").to_string(),
            "time": e.time.map(|t| t.format("%H:%M").to_string()),
            "instant": e.instant,
        })
    }

    fn read_json(r: Option<DateRead>) -> Value {
        match r {
            None => Value::Null,
            Some(r) => json!({
                "start": endpoint_json(&r.start),
                "end": r.end.as_ref().map(endpoint_json),
            }),
        }
    }

    #[test]
    fn replays_the_shared_date_cases() {
        let g = grammar().expect("the shipped grammar loads");
        for case in &g.cases {
            let name = case["name"].as_str().expect("a case has a name");
            let tz = Tz::from_str(case["zone"].as_str().expect("a case has a zone"))
                .expect("a case's zone is an IANA name");
            let input = &case["input"];
            let valid = match input {
                Value::Object(_) => range_fault(input).is_none(),
                _ => is_date_text(input),
            };
            assert_eq!(Value::Bool(valid), case["valid"], "valid: {name}");
            assert_eq!(
                read_json(read_date_value(input, &tz)),
                case["read"],
                "read: {name}"
            );
        }
    }

    #[test]
    fn a_rust_written_instant_reads_back() {
        // The shape `mcp.rs` `now_iso` and the scanner's stamps write.
        let at = Utc.with_ymd_and_hms(2026, 7, 28, 9, 20, 0).unwrap();
        let written = Value::String(at.format("%Y-%m-%dT%H:%M:%SZ").to_string());
        assert!(is_date_text(&written));
        let scanner = Value::String(at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true));
        assert!(is_date_text(&scanner));
        let sydney = Tz::from_str("Australia/Sydney").unwrap();
        let read = read_date_value(&written, &sydney).expect("reads");
        assert_eq!(
            read.start.date,
            NaiveDate::from_ymd_opt(2026, 7, 28).unwrap()
        );
        assert_eq!(read.start.time, NaiveTime::from_hms_opt(19, 20, 0));
        assert!(read.start.instant);
    }

    #[test]
    fn refuses_a_malformed_grammar() {
        let mut v: Value = serde_json::from_str(DATES_JSON).unwrap();
        let refuse = |v: &Value| parse_grammar(&v.to_string()).unwrap_err();
        v["format"] = json!(2);
        assert_eq!(refuse(&v), "dates: format must be 1, not 2");
        v["format"] = json!(1);
        v["rule_version"] = json!("");
        assert_eq!(refuse(&v), "dates: rule_version is empty");
        v["rule_version"] = json!("dates/test");
        v["forms"] = json!(["date", "week"]);
        assert_eq!(refuse(&v), "dates: unknown form week");
        v["forms"] = json!(["date"]);
        v["time_separators"] = json!([]);
        assert_eq!(refuse(&v), "dates: time_separators is empty");
        v["time_separators"] = json!([" "]);
        v["cases"] = json!([]);
        assert_eq!(refuse(&v), "dates: no cases");
    }

    #[test]
    fn nothing_in_this_module_reads_the_clock() {
        let source = include_str!("dates.rs");
        let body = source
            .split(concat!("#[cfg", "(test)]"))
            .next()
            .expect("the module has a body");
        for clock in [
            concat!("::", "now("),
            concat!("System", "Time"),
            concat!("Local", "::"),
            concat!("Instant", "::now"),
        ] {
            assert!(
                !body.contains(clock),
                "dates.rs reads the clock through {clock}"
            );
        }
    }

    #[test]
    fn replays_the_relative_date_cases() {
        for case in &grammar().unwrap().relative_cases {
            let today =
                NaiveDate::parse_from_str(case["today"].as_str().unwrap(), "%Y-%m-%d").unwrap();
            let actual = resolve_relative(
                case["input"].as_str().unwrap(),
                today,
                case["week_start"].as_u64().unwrap() as u32,
            );
            let got = actual.map(|(from, to)| {
                vec![
                    from.format("%Y-%m-%d").to_string(),
                    to.format("%Y-%m-%d").to_string(),
                ]
            });
            assert_eq!(
                serde_json::to_value(got).unwrap(),
                case["expect"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn refuses_malformed_relative_sections_in_the_shared_words() {
        let base: Value = serde_json::from_str(DATES_JSON).unwrap();
        let edits = [
            (
                "relative",
                Value::Null,
                "dates: relative has an invalid shape",
            ),
            (
                "days",
                json!([]),
                "dates: relative tokens must be non-empty and unique",
            ),
            (
                "week_starts",
                json!([1, 0]),
                "dates: relative week_starts must be 0, 1 in order",
            ),
            ("words", json!({}), "dates: relative words must name {n}"),
        ];
        for (key, value, words) in edits {
            let mut edited = base.clone();
            if key == "relative" {
                edited[key] = value;
            } else {
                edited["relative"][key] = value;
            }
            assert_eq!(parse_grammar(&edited.to_string()).unwrap_err(), words);
        }
        let mut bad = base.clone();
        bad["relative"]["offsets"]["max"] = json!(1000);
        assert_eq!(
            parse_grammar(&bad.to_string()).unwrap_err(),
            "dates: relative offsets are invalid"
        );
        let mut bad = base.clone();
        bad["relative"]["periods"][0]["unit"] = json!("year");
        assert_eq!(
            parse_grammar(&bad.to_string()).unwrap_err(),
            "dates: relative period unit has an unknown word year"
        );
        let mut bad = base;
        bad["relative_cases"] = json!([]);
        assert_eq!(
            parse_grammar(&bad.to_string()).unwrap_err(),
            "dates: no relative cases"
        );
    }
}
