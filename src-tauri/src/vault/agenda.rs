//! Dated records, never availability (M62.3). Every endpoint goes through
//! dates.rs, and placement replays fixtures/agenda-cases.json against the
//! calendar. The caller supplies readable entries and a zone; no I/O or
//! clock is available here.

use std::collections::BTreeSet;

#[cfg(test)]
use chrono::NaiveDate;
use chrono::{Duration, NaiveDateTime, NaiveTime};
use chrono_tz::Tz;
use serde_json::Value;

use super::dates::{self, Endpoint};
use super::entry::Entry;
use super::schema::{FieldDef, FieldKind, VaultSchema};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Window {
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
    pub converted: bool,
}

fn stamp(endpoint: Endpoint) -> NaiveDateTime {
    endpoint
        .date
        .and_time(endpoint.time.unwrap_or(NaiveTime::MIN))
}
fn full_time(value: NaiveDateTime) -> String {
    value.format("%Y-%m-%d %H:%M").to_string()
}
fn shown_time(value: NaiveDateTime) -> String {
    if value.time() == NaiveTime::MIN {
        value.date().to_string()
    } else {
        full_time(value)
    }
}
fn shown_endpoint(value: Endpoint) -> String {
    if value.time.is_none() {
        value.date.to_string()
    } else {
        full_time(stamp(value))
    }
}

pub(crate) fn parse_window(
    start: Option<&Value>,
    end: Option<&Value>,
    zone: Tz,
) -> Result<Window, String> {
    let (Some(start), Some(end)) = (start, end) else {
        return Err(
            "list_agenda needs start and end, such as start 2026-07-27 and end 2026-08-03".into(),
        );
    };
    let endpoint = |raw: &Value, name: &str| {
        raw.as_str().and_then(|text| dates::parse_date_text(text, &zone)).ok_or_else(|| format!("{name} must be a date such as 2026-07-27, a date and time such as 2026-07-27 09:00, or an exact time such as 2026-07-27T09:00:00Z"))
    };
    let start = endpoint(start, "start")?;
    let end = endpoint(end, "end")?;
    let window = Window {
        start: stamp(start),
        end: stamp(end),
        converted: start.instant || end.instant,
    };
    if window.end <= window.start {
        return Err("end must be after start".into());
    }
    if window.end - window.start > Duration::days(370) {
        return Err("the window is at most 370 days; narrow start and end".into());
    }
    Ok(window)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Placed {
    pub start: NaiveDateTime,
    /// Exclusive, or equal to start for a point.
    pub end: NaiveDateTime,
    pub point: bool,
    /// Inclusive first and last calendar day, as spanOf reads it.
    #[cfg(test)]
    pub days: (NaiveDate, NaiveDate),
    pub converted: bool,
    pub when: String,
    pub labels: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Reading {
    None,
    Unreadable,
    Dated(Placed),
}

/// Read leniently, preserving a usable start even when the end is absent,
/// junk or backwards. An instant is reported as converted, never presented
/// as if its local wall time had been authored in the file.
pub(crate) fn read_value(raw: Option<&Value>, zone: Tz) -> Reading {
    let Some(raw) = raw else {
        return Reading::None;
    };
    if raw.is_null() || raw.as_str().is_some_and(|text| text.trim().is_empty()) {
        return Reading::None;
    }
    let Some(read) = dates::read_date_value(raw, &zone) else {
        return Reading::Unreadable;
    };
    let a = read.start;
    let backwards = read.end.is_some_and(|end| {
        end.date < a.date
            || (end.date == a.date
                && matches!((a.time, end.time), (Some(start), Some(end)) if end < start))
    });
    let usable_end = if backwards { None } else { read.end };
    let mut labels = Vec::new();
    if raw.is_object() && read.end.is_none() {
        labels.push("no end".into());
    }
    if backwards {
        labels.push("end before start".into());
    }
    let mut converted = false;
    for (endpoint, text) in [
        (
            Some(a),
            raw.as_str()
                .or_else(|| raw.get("start").and_then(Value::as_str)),
        ),
        (read.end, raw.get("end").and_then(Value::as_str)),
    ] {
        if let (Some(endpoint), Some(text)) = (endpoint, text) {
            if endpoint.instant {
                converted = true;
                let label = format!("converted from {}", text.trim());
                if !labels.contains(&label) {
                    labels.push(label);
                }
            }
        }
    }
    let last = usable_end
        .map(|end| {
            if end.time == Some(NaiveTime::MIN) && end.date > a.date {
                end.date.pred_opt().unwrap_or(a.date)
            } else {
                end.date
            }
        })
        .unwrap_or(a.date)
        .max(a.date);
    let start = stamp(a);
    let point = a.time.is_some()
        && usable_end
            .is_none_or(|end| end.date == a.date && (end.time.is_none() || end.time <= a.time));
    let end = if point {
        start
    } else if a.time.is_none() {
        last.succ_opt()
            .expect("the grammar's year range leaves room for a day")
            .and_time(NaiveTime::MIN)
    } else if let Some(end) = usable_end {
        if end.time.is_some() {
            stamp(end)
        } else {
            end.date
                .succ_opt()
                .expect("the grammar's year range leaves room for a day")
                .and_time(NaiveTime::MIN)
        }
    } else {
        start
    };
    let mut when = shown_endpoint(a);
    if !point {
        if let Some(end) = usable_end.filter(|end| *end != a) {
            let end_text = match (end.date == a.date, end.time) {
                (true, Some(time)) => time.format("%H:%M").to_string(),
                _ => shown_endpoint(end),
            };
            when.push_str(&format!(" to {end_text}"));
        }
    }
    Reading::Dated(Placed {
        start,
        end,
        point,
        #[cfg(test)]
        days: (a.date, last),
        converted,
        when,
        labels,
    })
}

pub(crate) fn in_window(value: &Placed, window: &Window) -> bool {
    if value.point {
        window.start <= value.start && value.start < window.end
    } else {
        value.start < window.end && value.end > window.start
    }
}

pub(crate) fn repeat_pair(fields: &[FieldDef]) -> Option<&FieldDef> {
    fields
        .iter()
        .find(|field| field.kind == FieldKind::Daterange)
        .or_else(|| fields.iter().find(|field| field.kind == FieldKind::Date))
}
fn stored_date(field: &FieldDef) -> bool {
    matches!(field.kind, FieldKind::Date | FieldKind::Daterange)
}
fn record(entry: &Entry) -> bool {
    entry.entry_type.as_deref() != Some("Type")
        && !entry.path.starts_with("templates/")
        && !entry.path.starts_with("knowledge/")
}

#[derive(Debug, Clone)]
pub(crate) struct DatedRow {
    pub path: String,
    pub title: String,
    pub type_name: String,
    pub field: String,
    pub value: Placed,
    pub labels: Vec<String>,
}
#[derive(Debug, Default)]
pub(crate) struct Agenda {
    pub rows: Vec<DatedRow>,
    pub fields: Vec<(String, Vec<String>)>,
    pub undated: usize,
    pub unreadable: Vec<(String, String)>,
    pub unparsed: usize,
    pub repeating: usize,
    pub converted: bool,
    pub special: Option<String>,
}

/// The readable Type docs are the authority for date fields. A string that
/// happens to resemble a date does not acquire calendar meaning by itself.
pub(crate) fn collect(
    entries: &[Entry],
    schema: &VaultSchema,
    wanted: Option<&str>,
    window: &Window,
    zone: Tz,
) -> Agenda {
    let names: BTreeSet<_> = entries
        .iter()
        .filter(|entry| entry.entry_type.as_deref() == Some("Type") && entry.parse_error.is_none())
        .filter(|entry| wanted.is_none_or(|wanted| entry.title == wanted))
        .map(|entry| entry.title.clone())
        .collect();
    let mut agenda = Agenda {
        converted: window.converted,
        ..Agenda::default()
    };
    if let Some(wanted) = wanted {
        if !names.contains(wanted) {
            agenda.special = Some(format!("No Type doc this run can read declares {wanted}, so its records' dates are unknown."));
            return agenda;
        }
    }
    for name in names {
        let Some(own) = schema.type_named(&name) else {
            continue;
        };
        let fields: Vec<_> = own
            .fields
            .iter()
            .filter(|field| stored_date(field))
            .map(|field| field.name.clone())
            .collect();
        if !fields.is_empty() {
            agenda.fields.push((name, fields));
        }
    }
    if agenda.fields.is_empty() {
        agenda.special = Some(wanted.map(|name| format!("{name} declares no date or date range field, so its records have nothing to list.")).unwrap_or_else(|| "No database this run can read declares a date or date range field, so there is nothing to list.".into()));
        return agenda;
    }
    let mut entries: Vec<_> = entries.iter().filter(|entry| record(entry)).collect();
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    for entry in entries {
        if entry.parse_error.is_some() {
            agenda.unparsed += 1;
            continue;
        }
        let Some((name, fields)) = agenda
            .fields
            .iter()
            .find(|(name, _)| entry.entry_type.as_deref() == Some(name))
        else {
            continue;
        };
        let own = schema
            .type_named(name)
            .expect("fields came from the same schema");
        let pair = repeat_pair(&own.fields);
        let repeats = pair.is_some()
            && own
                .fields
                .iter()
                .find(|field| field.kind == FieldKind::Repeat)
                .and_then(|field| entry.properties.get(&field.name))
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty());
        if repeats {
            agenda.repeating += 1;
        }
        let mut present = false;
        for field in fields {
            let raw = schema.field_value(entry, field);
            match read_value(raw.as_ref(), zone) {
                Reading::None => {}
                Reading::Unreadable => {
                    present = true;
                    agenda.unreadable.push((entry.path.clone(), field.clone()));
                }
                Reading::Dated(value) => {
                    present = true;
                    if !in_window(&value, window) {
                        continue;
                    }
                    let mut labels = Vec::new();
                    if schema
                        .deadline_field(name)
                        .is_some_and(|deadline| &deadline.name == field)
                    {
                        labels.push("deadline".into());
                    }
                    if value.start < window.start {
                        labels.push("ongoing".into());
                    }
                    if repeats && pair.is_some_and(|pair| &pair.name == field) {
                        labels.push("repeats".into());
                    }
                    labels.extend(value.labels.clone());
                    agenda.converted |= value.converted;
                    agenda.rows.push(DatedRow {
                        path: entry.path.clone(),
                        title: entry.title.clone(),
                        type_name: name.clone(),
                        field: field.clone(),
                        value,
                        labels,
                    });
                }
            }
        }
        if !present {
            agenda.undated += 1;
        }
    }
    agenda.rows.sort_by(|a, b| {
        a.value
            .start
            .cmp(&b.value.start)
            .then_with(|| a.value.end.cmp(&b.value.end))
            .then_with(|| a.path.cmp(&b.path))
            .then_with(|| a.field.cmp(&b.field))
    });
    agenda
}

pub(crate) struct Listing<'a> {
    pub type_name: Option<&'a str>,
    pub limit: usize,
    pub limit_cut: bool,
    pub withheld: usize,
    pub zone: Tz,
}
fn plural<'a>(count: usize, one: &'a str, many: &'a str) -> &'a str {
    if count == 1 {
        one
    } else {
        many
    }
}

pub(crate) fn answer_text(agenda: &Agenda, window: &Window, listing: &Listing<'_>) -> String {
    let scope = if listing.withheld == 0 {
        String::new()
    } else {
        format!(
            " ({} {} outside this run's read scope {} not listed)",
            listing.withheld,
            plural(listing.withheld, "note", "notes"),
            plural(listing.withheld, "was", "were")
        )
    };
    if let Some(special) = &agenda.special {
        return format!("{special}{scope}");
    }
    let type_words = listing
        .type_name
        .map(|name| format!(" of type {name}"))
        .unwrap_or_default();
    let total = agenda.rows.len();
    let shown = total.min(listing.limit);
    let mut lines = if total == 0 {
        vec![format!("No dated entries{type_words} from {} to {} (end excluded).{scope} Only records with dates are listed, so this says nothing about free time.", shown_time(window.start), shown_time(window.end))]
    } else {
        let mut lines = vec![format!("{shown} of {total} dated {}{type_words} from {} to {} (end excluded), soonest first{scope}:", plural(total, "entry", "entries"), shown_time(window.start), shown_time(window.end))];
        for row in agenda.rows.iter().take(listing.limit) {
            let labels = row
                .labels
                .iter()
                .map(|label| format!(" · {label}"))
                .collect::<String>();
            lines.push(format!(
                "- {} — {} [{} · {}] — {}{labels}",
                row.value.when, row.title, row.type_name, row.field, row.path
            ));
        }
        lines
    };
    let mut footer = Vec::new();
    if total > shown {
        footer.push(format!(
            "{} more not listed; narrow the window or name a type{}.",
            total - shown,
            if listing.limit < 200 {
                ", or raise limit (at most 200)"
            } else {
                ""
            }
        ));
    }
    if listing.limit_cut {
        footer.push("The limit is at most 200.".into());
    }
    footer.push(format!(
        "Date fields read: {}",
        agenda
            .fields
            .iter()
            .map(|(name, fields)| format!("{name} ({})", fields.join(", ")))
            .collect::<Vec<_>>()
            .join("; ")
    ));
    if agenda.undated > 0 {
        footer.push(format!(
            "{} {} {} no date in any of those fields.",
            agenda.undated,
            plural(agenda.undated, "record", "records"),
            plural(agenda.undated, "has", "have")
        ));
    }
    if !agenda.unreadable.is_empty() {
        let count = agenda.unreadable.len();
        let named = agenda
            .unreadable
            .iter()
            .take(5)
            .map(|(path, field)| format!("{path} ({field})"))
            .collect::<Vec<_>>()
            .join(", ");
        footer.push(format!(
            "{count} {} in those fields could not be read as dates: {named}{}.",
            plural(count, "value", "values"),
            if count > 5 {
                format!(", and {} more", count - 5)
            } else {
                String::new()
            }
        ));
    }
    if agenda.repeating > 0 {
        footer.push(format!(
            "{} {} {}; each is listed only at its stored date, not at its later occurrences.",
            agenda.repeating,
            plural(agenda.repeating, "record", "records"),
            plural(agenda.repeating, "repeats", "repeat")
        ));
    }
    if agenda.unparsed > 0 {
        footer.push(format!(
            "{} {} {} frontmatter that could not be parsed, so whether {} dates is unknown.",
            agenda.unparsed,
            plural(agenda.unparsed, "note", "notes"),
            plural(agenda.unparsed, "has", "have"),
            plural(agenda.unparsed, "it holds", "they hold")
        ));
    }
    if agenda.converted {
        footer.push(format!(
            "Exact times were converted to local time in {}.",
            listing.zone
        ));
    }
    lines.push(String::new());
    lines.extend(footer);
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::super::schema;
    use super::*;
    use serde_json::json;
    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../fixtures/agenda-cases.json")).unwrap()
    }
    fn window(start: &str, end: &str) -> Window {
        parse_window(Some(&json!(start)), Some(&json!(end)), chrono_tz::UTC).unwrap()
    }
    fn entry(path: &str, text: &str) -> Entry {
        super::super::entry::build_entry(
            path,
            text,
            "2026-07-28T00:00:00Z".into(),
            "2026-07-28T00:00:00Z".into(),
        )
    }
    fn typedoc() -> Entry {
        entry("types/task.md", "---\ntype: Type\ndeadline: due\nfields:\n  due: date\n  window: daterange\n  later: date\n  word: text\n  stamp: created_time\n  answer: formula\n  repeat: repeat\n---\n# Task\n")
    }
    fn task(path: &str, fields: &str) -> Entry {
        entry(
            path,
            &format!(
                "---\ntype: Task\n{fields}---\n# {}\n",
                path.trim_end_matches(".md")
            ),
        )
    }
    fn agenda(entries: &[Entry], window: &Window) -> Agenda {
        collect(
            entries,
            &VaultSchema::from_entries(entries, schema::table().unwrap()),
            None,
            window,
            chrono_tz::UTC,
        )
    }
    fn listing() -> Listing<'static> {
        Listing {
            type_name: None,
            limit: 200,
            limit_cut: false,
            withheld: 0,
            zone: chrono_tz::UTC,
        }
    }
    #[test]
    fn replays_the_shared_agenda_cases() {
        let fixture = fixture();
        for case in fixture["values"].as_array().unwrap() {
            let zone = case["zone"].as_str().unwrap().parse().unwrap();
            let actual = match read_value(Some(&case["value"]), zone) {
                Reading::None => json!("none"),
                Reading::Unreadable => json!("unreadable"),
                Reading::Dated(value) => {
                    json!({"point":value.point,"days":[value.days.0.to_string(),value.days.1.to_string()],"converted":value.converted,"start":full_time(value.start),"end":full_time(value.end),"labels":value.labels})
                }
            };
            assert_eq!(actual, case["expect"], "{}", case["why"]);
        }
        for case in fixture["windows"].as_array().unwrap() {
            let zone = case["zone"].as_str().unwrap().parse().unwrap();
            let window =
                parse_window(Some(&case["window"][0]), Some(&case["window"][1]), zone).unwrap();
            let Reading::Dated(value) = read_value(Some(&case["value"]), zone) else {
                panic!("{} has a date", case["why"]);
            };
            assert_eq!(
                in_window(&value, &window),
                case["in"].as_bool().unwrap(),
                "{}",
                case["why"]
            );
        }
        for case in fixture["repeat_pairs"].as_array().unwrap() {
            let fields: Vec<_> = case["fields"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| schema::parse_field_def(row[0].as_str().unwrap(), &row[1]))
                .collect();
            assert_eq!(
                repeat_pair(&fields).map(|field| field.name.as_str()),
                case["pair"].as_str(),
                "{}",
                case["why"]
            );
        }
    }
    #[test]
    fn entries_sort_soonest_first_then_by_end_path_and_field() {
        let entries = vec![
            typedoc(),
            task("z.md", "due: '2026-07-28 10:00'\n"),
            task(
                "b.md",
                "due: '2026-07-28 10:00'\nlater: '2026-07-28 10:00'\n",
            ),
            task(
                "a.md",
                "window: {start: '2026-07-28 10:00', end: '2026-07-28 11:00'}\n",
            ),
            task("early.md", "due: '2026-07-28 09:00'\n"),
        ];
        let read = agenda(&entries, &window("2026-07-28", "2026-07-29"));
        assert_eq!(
            read.rows
                .iter()
                .map(|row| (row.path.as_str(), row.field.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("early.md", "due"),
                ("b.md", "due"),
                ("b.md", "later"),
                ("z.md", "due"),
                ("a.md", "window")
            ]
        );
    }
    #[test]
    fn only_fields_a_readable_type_doc_declares_as_dates_are_read() {
        let entries = vec![typedoc(), task("a.md", "due: 2026-07-28\nword: 2026-07-28\nwhen: 2026-07-28\nstamp: 2026-07-28\nanswer: 2026-07-28\n"), entry("unknown.md", "---\ntype: Hidden\ndue: 2026-07-28\n---\n# Hidden\n")];
        let read = agenda(&entries, &window("2026-07-28", "2026-07-29"));
        assert_eq!(read.rows.len(), 1);
        assert_eq!(read.rows[0].field, "due");
        assert_eq!(
            read.fields,
            vec![(
                "Task".into(),
                vec!["due".into(), "window".into(), "later".into()]
            )]
        );
    }
    #[test]
    fn templates_and_the_knowledge_bundle_are_never_listed() {
        let entries = vec![
            typedoc(),
            task("templates/task.md", "due: 2026-07-28\n"),
            task("knowledge/task.md", "due: 2026-07-28\n"),
            task("a.md", "due: 2026-07-28\n"),
        ];
        let read = agenda(&entries, &window("2026-07-28", "2026-07-29"));
        assert_eq!(
            read.rows
                .iter()
                .map(|row| row.path.as_str())
                .collect::<Vec<_>>(),
            vec!["a.md"]
        );
    }
    #[test]
    fn undated_unreadable_and_unparsed_are_counted_never_dropped() {
        let entries = vec![
            typedoc(),
            task("none.md", "due: null\n"),
            task("bad.md", "due: soon\n"),
            entry("broken.md", "---\ntype: [bad\n---\n# Broken\n"),
        ];
        let read = agenda(&entries, &window("2026-07-28", "2026-07-29"));
        assert_eq!(
            read.undated, 1,
            "invalid is recorded as unreadable, not absent"
        );
        assert_eq!(read.unreadable, vec![("bad.md".into(), "due".into())]);
        assert_eq!(read.unparsed, 1);
        let answer = answer_text(&read, &window("2026-07-28", "2026-07-29"), &listing());
        assert!(answer.contains("this says nothing about free time"));
        assert!(answer.contains("1 record has no date"));
        assert!(answer.contains("1 value in those fields could not be read"));
        assert!(answer.contains("1 note has frontmatter"));
    }
    #[test]
    fn a_repeating_record_is_listed_at_its_stored_date_and_counted() {
        let entries = vec![typedoc(), task("series.md", "window: {start: '2026-07-28 09:00', end: '2026-07-28 10:00'}\nrepeat: 'RRULE:FREQ=DAILY'\n")];
        let read = agenda(&entries, &window("2026-07-28", "2026-08-03"));
        assert_eq!(read.rows.len(), 1);
        assert_eq!(read.repeating, 1);
        assert_eq!(read.rows[0].labels, vec!["repeats"]);
        let later = agenda(&entries, &window("2026-07-29", "2026-08-03"));
        assert!(later.rows.is_empty(), "no recurrence expansion");
        assert_eq!(later.repeating, 1);
    }
    #[test]
    fn a_deadline_field_is_labelled_and_an_earlier_start_is_ongoing() {
        let entries = vec![
            typedoc(),
            task(
                "a.md",
                "due: 2026-07-28\nwindow: {start: 2026-07-20, end: 2026-07-31}\n",
            ),
        ];
        let read = agenda(&entries, &window("2026-07-28", "2026-07-29"));
        assert_eq!(read.rows[0].labels, vec!["ongoing"]);
        assert_eq!(read.rows[1].labels, vec!["deadline"]);
    }
    #[test]
    fn the_window_parser_refuses_in_words() {
        assert_eq!(
            parse_window(None, None, chrono_tz::UTC).unwrap_err(),
            "list_agenda needs start and end, such as start 2026-07-27 and end 2026-08-03"
        );
        assert!(parse_window(
            Some(&json!("soon")),
            Some(&json!("2026-08-03")),
            chrono_tz::UTC
        )
        .unwrap_err()
        .starts_with("start must be a date"));
        assert!(parse_window(
            Some(&json!("2026-07-28")),
            Some(&json!("soon")),
            chrono_tz::UTC
        )
        .unwrap_err()
        .starts_with("end must be a date"));
        assert_eq!(
            parse_window(
                Some(&json!("2026-07-28")),
                Some(&json!("2026-07-28")),
                chrono_tz::UTC
            )
            .unwrap_err(),
            "end must be after start"
        );
        assert!(parse_window(
            Some(&json!("2026-01-01")),
            Some(&json!("2027-01-06")),
            chrono_tz::UTC
        )
        .is_ok());
        assert_eq!(
            parse_window(
                Some(&json!("2026-01-01")),
                Some(&json!("2027-01-07")),
                chrono_tz::UTC
            )
            .unwrap_err(),
            "the window is at most 370 days; narrow start and end"
        );
        let shifted = parse_window(
            Some(&json!("2026-07-28T22:00:00Z")),
            Some(&json!("2026-07-28T23:00:00Z")),
            chrono_tz::Australia::Sydney,
        )
        .unwrap();
        assert_eq!(full_time(shifted.start), "2026-07-29 08:00");
        assert!(shifted.converted);
    }
    #[test]
    fn the_answer_text_is_exact() {
        let entries = vec![
            typedoc(),
            task(
                "a.md",
                "due: 2026-07-28\nwindow: {start: '2026-07-28 10:00', end: '2026-07-28 11:00'}\n",
            ),
            task("none.md", ""),
        ];
        let window = window("2026-07-28", "2026-07-29");
        let read = agenda(&entries, &window);
        let listing = Listing {
            limit: 1,
            withheld: 1,
            ..listing()
        };
        assert_eq!(answer_text(&read, &window, &listing), "1 of 2 dated entries from 2026-07-28 to 2026-07-29 (end excluded), soonest first (1 note outside this run's read scope was not listed):\n- 2026-07-28 — a [Task · due] — a.md · deadline\n\n1 more not listed; narrow the window or name a type, or raise limit (at most 200).\nDate fields read: Task (due, window, later)\n1 record has no date in any of those fields.");
    }
    #[test]
    fn the_demo_agenda_has_the_planned_windows_and_due_dates() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../demo-vault");
        let entries = super::super::scan::scan_vault(&root).unwrap();
        let wide = agenda(&entries, &window("2026-07-20", "2026-08-03"));
        assert_eq!(
            wide.rows.len(),
            39,
            "{:?}",
            wide.rows
                .iter()
                .map(|row| (&row.path, &row.field))
                .collect::<Vec<_>>()
        );
        let week = window("2026-07-27", "2026-08-03");
        let read = agenda(&entries, &week);
        assert_eq!(read.rows.len(), 20);
        assert_eq!(read.undated, 2);
        assert_eq!(
            read.rows
                .iter()
                .filter(|row| row.labels.iter().any(|label| label == "deadline"))
                .count(),
            5
        );
        assert!(read
            .rows
            .iter()
            .any(|row| row.path.contains("dec-postpone-multi-tenant-billing")));
        let paths: Vec<_> = read
            .rows
            .iter()
            .take(5)
            .map(|row| row.path.rsplit('/').next().unwrap())
            .collect();
        assert_eq!(
            paths,
            vec!["syn-1.md", "ops-3.md", "lnc-2.md", "lnc-8.md", "ops-9.md"]
        );
        let answer = answer_text(
            &read,
            &week,
            &Listing {
                limit: 5,
                ..listing()
            },
        );
        assert!(answer.starts_with("5 of 20 dated entries"));
        assert!(answer.contains("15 more not listed"));
        assert!(answer.contains("2 records have no date in any of those fields."));
        assert!(read.rows.iter().any(|row| row.path.ends_with("phx-421.md")
            && row
                .labels
                .iter()
                .any(|label| label == "converted from 2026-07-28T09:20:00Z")));
    }
    #[test]
    fn nothing_in_this_module_reads_the_clock_or_the_zone() {
        let production = include_str!("agenda.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap();
        for forbidden in [
            "::now(",
            "system_timezone(",
            "std::fs",
            "CorpusCache",
            "std::env",
            "Local::",
        ] {
            assert!(!production.contains(forbidden), "{forbidden}");
        }
    }
}
