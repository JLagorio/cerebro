//! Fixed native R1 SELECT and typed metadata digests; no writer or authority.
use super::*;
use rusqlite::types::ValueRef;
use serde::Deserialize;

pub(crate) const COLUMNS: &str = include_str!("../fixtures/native-restart-r1-columns.json");
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Projection {
    format: u8,
    base_sql: String,
    from_sql: String,
    where_sql: String,
    groups: Vec<Group>,
    codec: String,
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
        ValueRef::Real(_) => return Err("r1-nonfinite-real"),
        ValueRef::Text(bytes) | ValueRef::Blob(bytes) => {
            if bytes.len() > 16384 {
                return Err("r1-cell-cap");
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
    let bytes = serde_json::to_vec(value).map_err(|_| "r1-encode")?;
    if bytes.len() > 131072 {
        return Err("r1-projection-cap");
    }
    Ok(crate::ledger::sha256_hex(&bytes))
}
pub(super) fn snapshot(config: &Path) -> Result<Value, &'static str> {
    let projection: Projection = serde_json::from_str(COLUMNS).map_err(|_| "r1-columns")?;
    if projection.format != 1
        || projection.groups.len() != 8
        || projection.base_sql != SNAPSHOT
        || projection.codec.is_empty()
    {
        return Err("r1-projection-contract");
    }
    let mut select = vec!["base.value".to_owned()];
    for g in &projection.groups {
        if !identifier(&g.table)
            || !identifier(&g.alias)
            || g.columns.is_empty()
            || g.columns.len() > 64
            || !g.columns.iter().all(|c| identifier(c))
        {
            return Err("r1-columns-shape");
        }
        select.push(format!("(SELECT json_group_array(name) FROM (SELECT name FROM pragma_table_info('{}') ORDER BY cid))",g.table));
    }
    select.extend([
        "(SELECT count(*) FROM child_job_claims WHERE run_id=c.run_id)",
        "(SELECT count(*) FROM action_native_runs WHERE run_id=c.run_id AND (source_kind='job' OR child_job_id IS NOT NULL))",
        "(SELECT count(*) FROM child_job_reservations WHERE reserved_run_id=c.run_id)"
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
    let read = crate::runtime::ReadOnly::open(config).map_err(|_| "r1-read-open")?;
    let mut statement = read.prepare(&sql).map_err(|_| "r1-select-prepare")?;
    let mut rows = statement.query([]).map_err(|_| "r1-select-query")?;
    let row = rows
        .next()
        .map_err(|_| "r1-select-row")?
        .ok_or("r1-missing-row")?;
    let text: String = row.get(0).map_err(|_| "r1-scalar")?;
    for (i, g) in projection.groups.iter().enumerate() {
        let schema: String = row.get(i + 1).map_err(|_| "r1-schema")?;
        let columns: Vec<String> =
            serde_json::from_str(&schema).map_err(|_| "r1-schema-columns")?;
        if columns != g.columns {
            return Err("r1-full-column-mismatch");
        }
    }
    let markers: Vec<i64> = (9..12)
        .map(|i| row.get(i))
        .collect::<rusqlite::Result<_>>()
        .map_err(|_| "r1-markers")?;
    let mut at = 12;
    let mut groups = Vec::new();
    for g in &projection.groups {
        let mut values = Vec::new();
        for _ in &g.columns {
            values.push(cell(row.get_ref(at).map_err(|_| "r1-cell-read")?)?);
            at += 1;
        }
        groups.push(json!([g.label, g.columns, values]));
    }
    if rows.next().map_err(|_| "r1-extra-row")?.is_some() {
        return Err("r1-multiple-row");
    }
    let mut typed = Value::Array(groups);
    let protected = hashed(&typed)?;
    let usage = typed[0][2][8].clone();
    let group_digests = typed
        .as_array()
        .ok_or("r1-groups")?
        .iter()
        .map(hashed)
        .collect::<Result<Vec<_>, _>>()?;
    typed[0][2][8] = json!(["masked", null]);
    let mut base = decode_snapshot(&text)?;
    base["r1"] = json!({"version":1,"columnsDigest":crate::ledger::sha256_hex(COLUMNS.as_bytes()),
        "protectedDigest":protected,"withoutUsageDigest":hashed(&typed)?,"usage":usage,
        "markers":markers,"groupDigests":group_digests,
        "columnCounts":projection.groups.iter().map(|g|g.columns.len()).collect::<Vec<_>>()});
    Ok(base)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn m95_r1_typed_cells_are_actual_sqlite_values_without_null_or_float_loss() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let actual = conn
            .query_row(
                "SELECT NULL,-9223372036854775808,9223372036854775807,1.25,?1,'é',X'00ff'",
                [-0.0_f64],
                |row| {
                    Ok((0..7)
                        .map(|i| cell(row.get_ref(i).unwrap()).unwrap())
                        .collect::<Vec<_>>())
                },
            )
            .unwrap();
        assert_eq!(
            actual,
            vec![
                json!(["null", null]),
                json!(["integer", "-9223372036854775808"]),
                json!(["integer", "9223372036854775807"]),
                json!(["real", "3ff4000000000000"]),
                json!(["real", "8000000000000000"]),
                json!(["text", "c3a9"]),
                json!(["blob", "00ff"])
            ]
        );
    }
    #[test]
    fn m95_r1_projection_is_full_fixed_schema_and_original_snapshot() {
        let p: Projection = serde_json::from_str(COLUMNS).unwrap();
        assert_eq!(p.base_sql, SNAPSHOT);
        assert_eq!(
            p.groups.iter().map(|g| g.columns.len()).collect::<Vec<_>>(),
            vec![39, 9, 9, 4, 13, 3, 17, 17]
        );
        assert_eq!(p.groups[0].columns[8], "usage_state");
    }
}
