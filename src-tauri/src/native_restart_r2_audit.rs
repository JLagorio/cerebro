//! Fixed native R2 SELECT and typed metadata digests; no writer or authority.
use super::*;
use rusqlite::types::ValueRef;
use serde::Deserialize;

pub(crate) const COLUMNS: &str = include_str!("../fixtures/native-restart-r2-columns.json");
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Projection {
    format: u8,
    base_sql: String,
    from_sql: String,
    where_sql: String,
    groups: Vec<Group>,
    codec: String,
    masks: Masks,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Masks {
    session: Vec<[usize; 2]>,
    child: Vec<[usize; 2]>,
    parent: Vec<[usize; 2]>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Group {
    label: String,
    alias: String,
    table: String,
    columns: Vec<String>,
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn cell(value: ValueRef<'_>) -> Result<Value, &'static str> {
    Ok(match value {
        ValueRef::Null => json!(["null", null]),
        ValueRef::Integer(n) => json!(["integer", n.to_string()]),
        ValueRef::Real(n) if n.is_finite() => json!(["real", format!("{:016x}", n.to_bits())]),
        ValueRef::Real(_) => return Err("r2-nonfinite-real"),
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
            if bytes.len() > 16384 {
                return Err("r2-cell-cap");
            }
            json!([
                if matches!(value, ValueRef::Text(_)) {
                    "text"
                } else {
                    "blob"
                },
                hex(bytes)
            ])
        }
    })
}
fn hashed(value: &Value) -> Result<String, &'static str> {
    let bytes = serde_json::to_vec(value).map_err(|_| "r2-encode")?;
    if bytes.len() > 131072 {
        return Err("r2-projection-cap");
    }
    Ok(crate::ledger::sha256_hex(&bytes))
}
pub(in super::super) fn snapshot(config: &Path) -> Result<Value, &'static str> {
    let projection: Projection = serde_json::from_str(COLUMNS).map_err(|_| "r2-columns")?;
    if projection.format != 1
        || projection.groups.len() != 10
        || projection.base_sql != SNAPSHOT
        || projection.codec.is_empty()
    {
        return Err("r2-projection-contract");
    }
    if projection.masks.session != [[9, 4], [9, 5], [9, 6]]
        || projection.masks.child
            != [
                [0, 6],
                [0, 7],
                [0, 8],
                [1, 7],
                [1, 8],
                [2, 8],
                [6, 2],
                [6, 15],
                [6, 16],
            ]
        || projection.masks.parent != [[8, 6], [8, 7], [8, 8]]
    {
        return Err("r2-mask-contract");
    }
    let mut select = vec!["base.value".to_owned()];
    for g in &projection.groups {
        if !identifier(&g.table)
            || !identifier(&g.alias)
            || g.columns.is_empty()
            || g.columns.len() > 64
            || !g.columns.iter().all(|c| identifier(c))
        {
            return Err("r2-columns-shape");
        }
        select.push(format!("(SELECT json_group_array(name) FROM (SELECT name FROM pragma_table_info('{}') ORDER BY cid))",g.table));
    }
    select.extend([
        "(SELECT count(*) FROM child_job_claims WHERE run_id=c.run_id)",
        "(SELECT count(*) FROM action_native_runs WHERE run_id=c.run_id AND (source_kind='job' OR child_job_id IS NOT NULL))",
        "(SELECT count(*) FROM child_job_reservations WHERE reserved_run_id=c.run_id)",
        "(SELECT count(*) FROM app_sessions)",
        "(SELECT count(*) FROM client_tokens)"
    ].map(str::to_owned));
    for g in &projection.groups {
        for c in &g.columns {
            select.push(format!("{}.{}", g.alias, c));
        }
    }
    let sql = format!(
        "WITH base(value) AS ({}) SELECT {} {} CROSS JOIN base {}",
        projection.base_sql,
        select.join(","),
        projection.from_sql,
        projection.where_sql
    );
    let read = crate::runtime::ReadOnly::open(config).map_err(|_| "r2-read-open")?;
    let mut statement = read.prepare(&sql).map_err(|_| "r2-select-prepare")?;
    let mut rows = statement.query([]).map_err(|_| "r2-select-query")?;
    let row = rows
        .next()
        .map_err(|_| "r2-select-row")?
        .ok_or("r2-missing-row")?;
    let text: String = row.get(0).map_err(|_| "r2-scalar")?;
    for (i, g) in projection.groups.iter().enumerate() {
        let schema: String = row.get(i + 1).map_err(|_| "r2-schema")?;
        let columns: Vec<String> =
            serde_json::from_str(&schema).map_err(|_| "r2-schema-columns")?;
        if columns != g.columns {
            return Err("r2-full-column-mismatch");
        }
    }
    let markers: Vec<i64> = (11..14)
        .map(|i| row.get(i))
        .collect::<rusqlite::Result<_>>()
        .map_err(|_| "r2-markers")?;
    let session_count: i64 = row.get(14).map_err(|_| "r2-session-count")?;
    let client_tokens: i64 = row.get(15).map_err(|_| "r2-token-count")?;
    let old_vault: String = row.get(167).map_err(|_| "r2-vault-identity")?;
    let mut at = 16;
    let mut groups = Vec::new();
    for g in &projection.groups {
        let mut values = Vec::new();
        for _ in &g.columns {
            values.push(cell(row.get_ref(at).map_err(|_| "r2-cell-read")?)?);
            at += 1;
        }
        groups.push(json!([g.label, g.columns, values]));
    }
    if rows.next().map_err(|_| "r2-extra-row")?.is_some() {
        return Err("r2-multiple-row");
    }
    let typed = Value::Array(groups);
    let mut base = decode_snapshot(&text)?;
    base["r2"] = supplement(
        &typed,
        &projection,
        markers,
        session_count,
        client_tokens,
        crate::runtime::sessions::window_for(&old_vault),
    )?;
    Ok(base)
}
fn masked(typed: &Value, axes: &[[usize; 2]]) -> Result<String, &'static str> {
    let mut value = typed.clone();
    for [g, c] in axes {
        value[*g][2][*c] = json!(["masked", null]);
    }
    hashed(&value)
}
fn supplement(
    typed: &Value,
    p: &Projection,
    markers: Vec<i64>,
    session_count: i64,
    client_tokens: i64,
    window: Option<crate::runtime::sessions::SessionWindow>,
) -> Result<Value, &'static str> {
    Ok(
        json!({"version":1,"columnsDigest":crate::ledger::sha256_hex(COLUMNS.as_bytes()),
        "fullDigest":hashed(typed)?,"withoutSessionCloseDigest":masked(typed,&p.masks.session)?,
        "withoutChildTerminalDigest":masked(typed,&p.masks.child)?,
        "withoutParentTerminalDigest":masked(typed,&p.masks.parent)?,
        "groupDigests":typed.as_array().ok_or("r2-groups")?.iter().map(hashed).collect::<Result<Vec<_>,_>>()?,
        "columnCounts":p.groups.iter().map(|g|g.columns.len()).collect::<Vec<_>>(),
        "markers":markers,"sessionCount":session_count,"clientTokens":client_tokens,"sessionWindow":window}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn m95_r2_masks_exclude_only_actual_writer_columns() {
        let p: Projection = serde_json::from_str(COLUMNS).unwrap();
        let groups = p
            .groups
            .iter()
            .map(|g| {
                json!([
                    g.label,
                    g.columns,
                    g.columns
                        .iter()
                        .map(|_| json!(["null", null]))
                        .collect::<Vec<_>>()
                ])
            })
            .collect::<Vec<_>>();
        let initial = Value::Array(groups);
        for axes in [&p.masks.session, &p.masks.child, &p.masks.parent] {
            let before = masked(&initial, axes).unwrap();
            for (g, group) in p.groups.iter().enumerate() {
                for c in 0..group.columns.len() {
                    let mut changed = initial.clone();
                    changed[g][2][c] = json!(["text", "74616d706572"]);
                    assert_eq!(
                        masked(&changed, axes).unwrap() == before,
                        axes.contains(&[g, c]),
                        "{g}/{c}"
                    );
                }
            }
        }
        for (axes, expected) in [
            (
                &p.masks.session,
                vec![
                    "old-session.last_heartbeat_at",
                    "old-session.clean_closed_at",
                    "old-session.close_precision",
                ],
            ),
            (
                &p.masks.child,
                vec![
                    "child-run.ended_at",
                    "child-run.outcome",
                    "child-run.usage_state",
                    "claim.state",
                    "claim.ended_at",
                    "reservation.occupies_slot",
                    "child-native.revision",
                    "child-native.closed_at",
                    "child-native.close_kind",
                ],
            ),
            (
                &p.masks.parent,
                vec![
                    "parent-run.ended_at",
                    "parent-run.outcome",
                    "parent-run.usage_state",
                ],
            ),
        ] {
            assert_eq!(
                axes.iter()
                    .map(|[g, c]| format!("{}.{}", p.groups[*g].label, p.groups[*g].columns[*c]))
                    .collect::<Vec<_>>(),
                expected
            );
        }
        assert_eq!(p.base_sql, SNAPSHOT);
        assert_eq!(p.groups.iter().map(|g| g.columns.len()).sum::<usize>(), 157);
    }
}
