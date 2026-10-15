//! XLSX is an import/export format, not a vault carrier. An untrusted archive
//! is bounded before upstream IronCalc sees it; only source fences leave here.
use super::{
    edit,
    engine::{self, EngineThread, SheetCellSource, SheetInput},
    fence,
};
use base64::Engine;
use ironcalc_base::{
    cell::CellValue,
    expressions::{
        parser::{new_parser_english, stringify::to_english_string, Node},
        types::CellReferenceRC,
    },
    types::{Cell, CellType, FormulaValue, SheetState},
    Model,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::OpenOptions,
    io::Read,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

/// Compute once on the engine thread, then hand only bytes to the save dialog.
/// No path-taking upstream exporter is used: this cannot write into the vault.
pub fn workbook_xlsx(body: String, zone: String) -> Result<Vec<u8>, String> {
    engine::run_on_engine_thread(move |thread| encode_xlsx(thread, &body, &zone))
}
fn encode_xlsx(thread: &EngineThread, body: &str, zone: &str) -> Result<Vec<u8>, String> {
    let fences = fence::read_fences(body);
    if fences.is_empty() {
        return Err("This page has no sheets to export.".to_string());
    }
    let mut inputs = Vec::with_capacity(fences.len());
    for fence in &fences {
        let Some(input) = fence.input() else {
            return Err(format!(
                "“{}” can't be read, so nothing was exported: {}",
                fence.name,
                fence.parsed.problem().unwrap_or("unreadable sheet")
            ));
        };
        inputs.push(input);
    }
    let workbook = engine::build_model(thread, &inputs, zone)?;
    for result in &workbook.results {
        if let engine::SheetResult::Unavailable(problem) = result {
            return Err(format!(
                "“{}” can't be read, so nothing was exported: {}",
                problem.name, problem.message
            ));
        }
    }
    ironcalc::export::save_xlsx_to_writer(
        workbook.model.get_model(),
        std::io::Cursor::new(Vec::new()),
    )
    .map(|writer| writer.into_inner())
    .map_err(|_| "The workbook couldn't be encoded as Excel.".to_string())
}

const FILE_CAP: u64 = 32 * 1024 * 1024;
const PART_CAP: usize = 10_000;
const EXPANDED_CAP: u64 = 256 * 1024 * 1024;
fn refusal(reason: &str) -> String {
    format!("This isn't an Excel workbook Cerebro can read: {reason}.")
}
fn corrupt() -> String {
    refusal("it isn't a valid, unencrypted .xlsx file")
}
fn stopped() -> String {
    refusal("the importer stopped on part of it")
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
    pub cell: String,
    pub before: String,
    pub after: String,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    pub count: usize,
    pub first: Vec<Difference>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub compared: usize,
    pub differ: usize,
    pub first: Vec<Difference>,
    pub unsaved: usize,
    pub volatile: usize,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub charts: usize,
    pub chart_sheets: usize,
    pub images: usize,
    pub pivots: usize,
    pub macros: bool,
    pub external_links: usize,
    pub notes: usize,
    pub tables: usize,
    pub merged: usize,
    pub hidden: usize,
    pub frozen: usize,
    pub conditional_formats: usize,
    pub formatting: bool,
    pub names_inlined: usize,
    pub names_left: Vec<String>,
    pub formats_lost: usize,
    pub changed: Changed,
    pub saved: Saved,
    // Import-time cache presence is not part of the renderer's loss report.
    #[serde(skip)]
    missing_cache: BTreeSet<(String, i32, i32)>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetSummary {
    pub name: String,
    pub rows: i32,
    pub columns: i32,
    pub filled: usize,
    pub formulas: usize,
    pub hidden: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxImport {
    pub body: String,
    pub sheets: Vec<SheetSummary>,
    pub report: ImportReport,
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PickedSheet {
    Csv {
        name: String,
        #[serde(rename = "bytesBase64")]
        bytes_base64: String,
    },
    Xlsx {
        name: String,
        workbook: Box<XlsxImport>,
    },
}

pub fn read_sheet_file(path: &Path, tz: &str) -> Result<PickedSheet, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| corrupt())?;
    if !metadata.is_file() {
        return Err(refusal("choose a regular file"));
    }
    if metadata.len() > FILE_CAP {
        return Err("Choose a file up to 32 MB.".into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| corrupt())?;
    if !file.metadata().map_err(|_| corrupt())?.is_file() {
        return Err(refusal("choose a regular file"));
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(FILE_CAP + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| corrupt())?;
    if bytes.len() as u64 > FILE_CAP {
        return Err("Choose a file up to 32 MB.".into());
    }
    let name = path
        .file_name()
        .map(|v| v.to_string_lossy().into_owned())
        .ok_or_else(corrupt)?;
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "csv" => Ok(PickedSheet::Csv {
            name,
            bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        }),
        "xlsx" | "xlsm" => {
            let stem = path
                .file_stem()
                .map(|v| v.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Workbook".into());
            let tz = tz.to_string();
            let workbook =
                engine::run_on_engine_thread(move |thread| decode_xlsx(thread, &bytes, &stem, &tz))
                    .map_err(|e| if e == engine::STOPPED { stopped() } else { e })?;
            Ok(PickedSheet::Xlsx {
                name,
                workbook: Box::new(workbook),
            })
        }
        _ => Err("Cerebro imports .xlsx, .xlsm and .csv files.".into()),
    }
}
fn check_archive(bytes: &[u8]) -> Result<ImportReport, String> {
    check_archive_limits(bytes, PART_CAP, EXPANDED_CAP)
}
fn archive_error(error: crate::files::extract::Failure) -> String {
    use crate::files::extract::Failure;
    match error {
        Failure::TooLarge { detail } if detail.contains("entries") => {
            refusal("it holds more than 10,000 parts")
        }
        Failure::TooLarge { .. } => refusal("it would expand past 256 MB"),
        Failure::Corrupt { detail } if detail.contains("duplicate") => {
            refusal("two of its parts share a name")
        }
        Failure::Corrupt { detail } if detail.contains("XML") => {
            refusal("part of it isn't valid XML")
        }
        _ => corrupt(),
    }
}
/// Upstream expands declared arrays during parsing, before a Model exists.
/// Bound that work, shared-string materialization and coercive value fallbacks
/// before calling it. Unqualified attributes match roxmltree's exact lookup.
fn preflight_xml(
    root: &crate::files::extract::xml::Node,
    arrays: &mut usize,
    strings: &mut usize,
    cells: &mut usize,
    missing: &mut BTreeSet<(i32, i32)>,
) -> Result<(), String> {
    use engine::{
        SHEET_MAX_CELLS, SHEET_MAX_CELL_CHARS, SHEET_MAX_COLUMNS, SHEET_MAX_PAGE_CHARS,
        SHEET_MAX_ROWS,
    };
    for formula in root.descendants("f") {
        if formula.raw_attr("t") != Some("array") {
            continue;
        }
        let range = formula.raw_attr("ref").ok_or_else(corrupt)?;
        let mut parts = range.split(':');
        let first = super::ai::parse_address(parts.next().unwrap_or("")).map_err(|_| corrupt())?;
        let last =
            super::ai::parse_address(parts.next().unwrap_or(range)).map_err(|_| corrupt())?;
        if parts.next().is_some() || last.row < first.row || last.col < first.col {
            return Err(corrupt());
        }
        if last.row > SHEET_MAX_ROWS || last.col > SHEET_MAX_COLUMNS {
            return Err(refusal(
                "an array formula extends beyond 500 rows or 26 columns",
            ));
        }
        let area = (last.row - first.row + 1) as usize * (last.col - first.col + 1) as usize;
        *arrays = arrays.saturating_add(area);
        if *arrays > SHEET_MAX_CELLS {
            return Err(refusal("its array formulas expand beyond 10,000 cells"));
        }
    }
    for name in ["si", "is"] {
        for string in root.descendants(name) {
            if string.descendants(name).nth(1).is_some() {
                return Err(refusal(
                    "a shared or inline string is nested inside another string",
                ));
            }
            let count = string.descendants("t").try_fold(0_usize, |count, text| {
                if !text.children.is_empty() {
                    return Err(corrupt());
                }
                Ok(count.saturating_add(text.text.chars().count()))
            })?;
            if count > SHEET_MAX_CELL_CHARS {
                return Err(refusal("a string holds more than 10,000 characters"));
            }
            *strings = strings.saturating_add(count);
            if *strings > SHEET_MAX_PAGE_CHARS {
                return Err(refusal("its strings hold more than 2,000,000 characters"));
            }
        }
    }
    for cell in root.descendants("c") {
        let values: Vec<_> = cell.children.iter().filter(|n| n.name == "v").collect();
        if values.len() > 1 {
            return Err(corrupt());
        }
        let value = values.first().map(|n| n.text.as_str());
        let kind = cell
            .raw_attr("t")
            .unwrap_or(if value.is_some() { "n" } else { "empty" });
        let uncached =
            cell.child("f").is_some() && (value.is_none() || (kind != "str" && value == Some("")));
        if uncached {
            let at = super::ai::parse_address(cell.raw_attr("r").ok_or_else(corrupt)?)
                .map_err(|_| corrupt())?;
            missing.insert((at.row, at.col));
        }
        if kind == "n"
            && !uncached
            && !value
                .and_then(|v| v.parse::<f64>().ok())
                .is_some_and(f64::is_finite)
        {
            return Err(refusal("a numeric cell has no valid finite value"));
        }
        if kind == "b" && !uncached && !matches!(value, Some("0" | "1")) {
            return Err(refusal("a boolean cell has no valid value"));
        }
        if kind == "d" {
            return Err(refusal("a cell uses an unsupported explicit date value"));
        }
        if !matches!(kind, "n" | "b" | "s" | "str" | "inlineStr" | "e" | "empty") {
            return Err(refusal("a cell uses an unsupported value type"));
        }
        if cell.child("f").is_some()
            || cell.child("is").is_some()
            || value.is_some_and(|v| !v.is_empty())
        {
            *cells = cells.saturating_add(1);
            if *cells > SHEET_MAX_CELLS {
                return Err(refusal("it holds more than 10,000 filled cells"));
            }
        }
    }
    Ok(())
}
fn check_archive_limits(bytes: &[u8], parts: usize, expanded: u64) -> Result<ImportReport, String> {
    use crate::files::extract::{package::Package, Limits};
    let mut archive = Package::new(
        bytes.to_vec(),
        "xlsx",
        Limits {
            file_bytes: FILE_CAP,
            zip_entries: parts,
            part_bytes: expanded,
            total_parts_bytes: expanded,
            ..Limits::SHIPPED
        },
    )
    .map_err(archive_error)?;
    archive.verify_all().map_err(archive_error)?;
    let mut report = ImportReport::default();
    let (mut arrays, mut strings, mut cells) = (0, 0, 0);
    let mut uncached_parts = BTreeMap::new();
    for name in archive.names() {
        let root = if name.ends_with(".xml") {
            let root = archive.xml(&name).map_err(archive_error)?;
            let mut missing = BTreeSet::new();
            preflight_xml(&root, &mut arrays, &mut strings, &mut cells, &mut missing)?;
            if !missing.is_empty() {
                uncached_parts.insert(name.clone(), missing);
            }
            Some(root)
        } else {
            None
        };
        let leaf = name.rsplit('/').next().unwrap_or("");
        if name.starts_with("xl/charts/")
            && leaf.ends_with(".xml")
            && root.as_ref().is_some_and(|root| root.name == "chartSpace")
            && !name.contains("/_rels/")
        {
            report.charts += 1;
        }
        if name.starts_with("xl/chartsheets/")
            && name.ends_with(".xml")
            && !name.contains("/_rels/")
        {
            report.chart_sheets += 1;
        }
        if name.starts_with("xl/media/") && !name.ends_with('/') {
            report.images += 1;
        }
        if name.starts_with("xl/pivottables/")
            && name.ends_with(".xml")
            && !name.contains("/_rels/")
        {
            report.pivots += 1;
        }
        if name.starts_with("xl/externallinks/")
            && name.ends_with(".xml")
            && !name.contains("/_rels/")
        {
            report.external_links += 1;
        }
        if name == "xl/vbaproject.bin" {
            report.macros = true;
        }
    }
    if !uncached_parts.is_empty() {
        if let Some(workbook) = archive
            .optional_xml("xl/workbook.xml")
            .map_err(archive_error)?
        {
            let rels = archive
                .relationships("xl/workbook.xml")
                .map_err(archive_error)?;
            for sheet in workbook.descendants("sheet") {
                let Some(name) = sheet.raw_attr("name") else {
                    continue;
                };
                // The namespace prefix is arbitrary; any ambiguous id can
                // only mark a cache absent, never manufacture a saved value.
                for (key, id) in &sheet.raw_attrs {
                    if key != "id" && !key.ends_with(":id") {
                        continue;
                    }
                    if let Some(missing) = rels
                        .get(id)
                        .filter(|rel| !rel.external)
                        .and_then(|rel| uncached_parts.get(&rel.target.to_ascii_lowercase()))
                    {
                        for (row, col) in missing {
                            report.missing_cache.insert((name.to_owned(), *row, *col));
                        }
                    }
                }
            }
        }
    }
    Ok(report)
}

#[derive(Clone, Debug, PartialEq)]
struct Value {
    kind: &'static str,
    text: String,
    number: Option<f64>,
}
fn value(model: &Model<'_>, sheet: u32, row: i32, col: i32) -> Result<Value, String> {
    let cell = model.workbook.worksheet(sheet)?.cell(row, col);
    let result = model.get_cell_value_by_index(sheet, row, col)?;
    Ok(match result {
        CellValue::None => Value {
            kind: "blank",
            text: String::new(),
            number: None,
        },
        CellValue::String(text) => Value {
            kind: if cell.is_some_and(|c| c.get_type() == CellType::ErrorValue) {
                "error"
            } else {
                "text"
            },
            text,
            number: None,
        },
        CellValue::Boolean(b) => Value {
            kind: "boolean",
            text: if b { "TRUE" } else { "FALSE" }.into(),
            number: None,
        },
        CellValue::Number(n) => Value {
            kind: "number",
            text: n.to_string(),
            number: Some(n),
        },
    })
}
fn equal(a: &Value, b: &Value) -> bool {
    if a.kind != b.kind {
        return false;
    }
    match (a.number, b.number) {
        (Some(a), Some(b)) => (a - b).abs() <= 1e-9 * a.abs().max(b.abs()).max(1.0),
        _ => a.text == b.text,
    }
}
fn address(sheet: &str, row: i32, col: i32) -> String {
    format!(
        "{sheet}!{}{row}",
        ironcalc_base::expressions::utils::number_to_column(col).unwrap_or_default()
    )
}
fn is_volatile(formula: &str) -> bool {
    let tokens =
        ironcalc_base::expressions::lexer::util::get_tokens(formula.trim_start_matches('='));
    tokens.iter().any(|token| matches!(&token.token, ironcalc_base::expressions::token::TokenType::Ident(name) if ["NOW", "TODAY", "RAND", "RANDBETWEEN", "RANDARRAY"].contains(&name.to_ascii_uppercase().as_str())))
}
fn walk_names(
    node: &mut Node,
    parser: &mut ironcalc_base::expressions::parser::Parser<'_>,
    context: &CellReferenceRC,
    names: &[String],
    inlined: &mut bool,
    left: &mut BTreeSet<String>,
) {
    match node {
        Node::DefinedNameKind((name, scope, formula)) => {
            let at = CellReferenceRC {
                sheet: scope
                    .and_then(|i| names.get(i as usize))
                    .cloned()
                    .unwrap_or_else(|| context.sheet.clone()),
                row: 1,
                column: 1,
            };
            let mut replacement = parser.parse(formula.trim_start_matches('='), &at);
            let acceptable = match &mut replacement {
                Node::ReferenceKind {
                    sheet_name,
                    sheet_index,
                    absolute_row: true,
                    absolute_column: true,
                    ..
                }
                | Node::RangeKind {
                    sheet_name,
                    sheet_index,
                    absolute_row1: true,
                    absolute_column1: true,
                    absolute_row2: true,
                    absolute_column2: true,
                    ..
                } => {
                    *sheet_name = names.get(*sheet_index as usize).cloned();
                    true
                }
                Node::BooleanKind(_)
                | Node::NumberKind(_)
                | Node::StringKind(_)
                | Node::ErrorKind(_) => true,
                _ => false,
            };
            if acceptable {
                *node = replacement;
                *inlined = true;
            } else {
                left.insert(name.clone());
            }
        }
        Node::OpRangeKind { left: a, right: b }
        | Node::OpConcatenateKind { left: a, right: b }
        | Node::OpSumKind {
            left: a, right: b, ..
        }
        | Node::OpProductKind {
            left: a, right: b, ..
        }
        | Node::OpPowerKind { left: a, right: b }
        | Node::CompareKind {
            left: a, right: b, ..
        } => {
            walk_names(a, parser, context, names, inlined, left);
            walk_names(b, parser, context, names, inlined, left);
        }
        Node::FunctionKind { args, .. } | Node::NamedFunctionKind { args, .. } => {
            for arg in args {
                walk_names(arg, parser, context, names, inlined, left);
            }
        }
        Node::LambdaDefKind { body, .. } => walk_names(body, parser, context, names, inlined, left),
        Node::LambdaCallKind { lambda, args } => {
            walk_names(lambda, parser, context, names, inlined, left);
            for arg in args {
                walk_names(arg, parser, context, names, inlined, left);
            }
        }
        Node::ImplicitIntersection { child, .. }
        | Node::SpillRangeOperator { child }
        | Node::UnaryKind { right: child, .. } => {
            walk_names(child, parser, context, names, inlined, left)
        }
        _ => {}
    }
}
fn inline_names(
    model: &Model<'_>,
    formula: &str,
    sheet: u32,
    row: i32,
    column: i32,
    report: &mut ImportReport,
) -> String {
    let names: Vec<_> = model
        .workbook
        .worksheets
        .iter()
        .map(|s| s.name.clone())
        .collect();
    let mut parser = new_parser_english(
        names.clone(),
        model.workbook.get_defined_names_with_scope(),
        model.workbook.tables.clone(),
    );
    let context = CellReferenceRC {
        sheet: names[sheet as usize].clone(),
        row,
        column,
    };
    let mut node = parser.parse(formula.trim_start_matches('='), &context);
    let mut replaced = false;
    let mut left: BTreeSet<_> = report.names_left.iter().cloned().collect();
    walk_names(
        &mut node,
        &mut parser,
        &context,
        &names,
        &mut replaced,
        &mut left,
    );
    report.names_left = left.into_iter().collect();
    if replaced {
        report.names_inlined += 1;
    }
    format!("={}", to_english_string(&node, &context))
}
fn source_of(
    thread: &EngineThread,
    model: &Model<'_>,
    probe: &mut Model<'_>,
    sheet: u32,
    row: i32,
    col: i32,
    report: &mut ImportReport,
) -> Result<String, String> {
    let _ = thread;
    let Some(cell) = model.workbook.worksheet(sheet)?.cell(row, col) else {
        return Ok(String::new());
    };
    if matches!(cell, Cell::EmptyCell { .. } | Cell::SpillCell { .. }) {
        return Ok(String::new());
    }
    if let Some(formula) = model.get_cell_formula(sheet, row, col)? {
        return Ok(inline_names(model, &formula, sheet, row, col, report));
    }
    let raw = value(model, sheet, row, col)?;
    if raw.kind == "number" {
        let formatted = model.get_formatted_cell_value(sheet, row, col)?;
        probe.set_user_input(0, 1, 1, formatted.clone())?;
        let typed = value(probe, 0, 1, 1)?;
        if typed.kind == "number" && typed.number == raw.number {
            return Ok(formatted);
        }
        report.formats_lost += 1;
        return Ok(raw.text);
    }
    if raw.kind == "text" {
        probe.set_user_input(0, 1, 1, raw.text.clone())?;
        if value(probe, 0, 1, 1)? != raw || probe.get_cell_formula(0, 1, 1)?.is_some() {
            return Ok(format!("'{}", raw.text));
        }
    }
    Ok(raw.text)
}
fn positions(model: &Model<'_>) -> Vec<(u32, i32, i32)> {
    let mut cells: Vec<_> = model
        .get_all_cells()
        .into_iter()
        .map(|c| (c.index, c.row, c.column))
        .collect();
    cells.sort();
    cells
}
fn check_extents(model: &Model<'_>) -> Result<(), String> {
    if model.workbook.worksheets.is_empty() {
        return Err("This workbook has no sheets to import.".into());
    }
    if model.workbook.worksheets.len() > engine::SHEET_MAX_SHEETS {
        return Err(format!(
            "This page holds {} sheets. A page computes at most {}.",
            model.workbook.worksheets.len(),
            engine::SHEET_MAX_SHEETS
        ));
    }
    let mut count = 0;
    for sheet in &model.workbook.worksheets {
        let mut rows = 0;
        let mut columns = 0;
        for (&row, cells) in &sheet.sheet_data {
            for (&col, cell) in cells {
                if !matches!(cell, Cell::EmptyCell { .. }) {
                    rows = rows.max(row);
                    columns = columns.max(col);
                    count += 1;
                }
            }
        }
        if rows > engine::SHEET_MAX_ROWS || columns > engine::SHEET_MAX_COLUMNS {
            return Err(format!("“{}” spans {rows} rows × {columns} columns; a sheet holds up to {} rows × {} columns.", sheet.name, engine::SHEET_MAX_ROWS, engine::SHEET_MAX_COLUMNS));
        }
    }
    if count > engine::SHEET_MAX_CELLS {
        return Err(format!(
            "This workbook has {count} cells; a page holds up to {}.",
            engine::SHEET_MAX_CELLS
        ));
    }
    Ok(())
}
pub fn decode_xlsx(
    thread: &EngineThread,
    bytes: &[u8],
    name: &str,
    tz: &str,
) -> Result<XlsxImport, String> {
    let mut report = check_archive(bytes)?;
    let workbook =
        ironcalc::import::load_from_xlsx_bytes(bytes, name, "en", tz).map_err(|e| match e {
            ironcalc::error::XlsxError::Xml(_) => refusal("part of it isn't valid XML"),
            ironcalc::error::XlsxError::NotImplemented(feature) => {
                refusal(&format!("it uses {feature}, which can't be imported yet"))
            }
            _ => corrupt(),
        })?;
    let mut model = Model::from_workbook(workbook, "en").map_err(|_| corrupt())?;
    check_extents(&model)?;
    let mut saved = Vec::new();
    let mut volatile = BTreeSet::new();
    for (sheet, row, col) in positions(&model) {
        if let Some(formula) = model.get_cell_formula(sheet, row, col)? {
            if is_volatile(&formula) {
                volatile.insert((sheet, row, col));
                report.saved.volatile += 1;
                continue;
            }
            let cell = model.workbook.worksheet(sheet)?.cell(row, col);
            let sheet_name = model.workbook.worksheet(sheet)?.name.clone();
            if report.missing_cache.contains(&(sheet_name, row, col))
                || matches!(
                    cell,
                    Some(
                        Cell::CellFormula {
                            v: FormulaValue::Unevaluated,
                            ..
                        } | Cell::ArrayFormula {
                            v: FormulaValue::Unevaluated,
                            ..
                        }
                    )
                )
            {
                report.saved.unsaved += 1;
            } else {
                saved.push(((sheet, row, col), value(&model, sheet, row, col)?));
            }
        }
    }
    // Inspect all formula sources before evaluating the imported workbook too.
    let checks: Vec<_> = model
        .workbook
        .worksheets
        .iter()
        .enumerate()
        .map(|(index, ws)| {
            let cells = positions(&model)
                .into_iter()
                .filter(|(sheet, _, _)| *sheet == index as u32)
                .map(|(_, row, col)| {
                    Ok(SheetCellSource {
                        row,
                        col,
                        source: model
                            .get_cell_formula(index as u32, row, col)?
                            .unwrap_or_default(),
                    })
                })
                .collect::<Result<Vec<_>, String>>()?;
            Ok(SheetInput {
                name: ws.name.clone(),
                cells,
            })
        })
        .collect::<Result<_, String>>()?;
    engine::check_workbook(&checks)?;
    for sheet in &checks {
        if let Some(problem) = engine::sheet_problem(sheet) {
            return Err(problem);
        }
    }
    model.evaluate();
    check_extents(&model)?;
    report.formatting = true;
    report.tables = model.workbook.tables.len();
    let mut sources = Vec::new();
    let mut summaries = Vec::new();
    let mut probe = Model::new_empty("probe", "en", tz, "en")?;
    for (index, ws) in model.workbook.worksheets.iter().enumerate() {
        let hidden = ws.state != SheetState::Visible;
        report.hidden += usize::from(hidden);
        report.notes += ws.comments.len();
        report.merged += ws.merge_cells.len();
        report.frozen += usize::from(ws.frozen_rows > 0 || ws.frozen_columns > 0);
        report.conditional_formats += ws.conditional_formatting.len();
        let mut cells = Vec::new();
        let mut rows = 0;
        let mut columns = 0;
        let mut formulas = 0;
        for (sheet, row, col) in positions(&model)
            .into_iter()
            .filter(|(sheet, _, _)| *sheet == index as u32)
        {
            let source = source_of(thread, &model, &mut probe, sheet, row, col, &mut report)?;
            if source.is_empty() {
                continue;
            }
            // The source writer rejects carrier-breaking inputs rather than silently corrupting them.
            if source.chars().count() > engine::SHEET_MAX_CELL_CHARS {
                return Err(refusal("a cell holds more than 10,000 characters"));
            }
            if source
                .chars()
                .any(|c| c <= '\u{1f}' && !['\n', '\r', '\t'].contains(&c))
            {
                return Err(refusal(
                    "a cell holds a control character a page can't carry",
                ));
            }
            if source.lines().any(|line| {
                let trimmed = line.trim_start_matches(' ');
                line.len() - trimmed.len() <= 3
                    && (trimmed.starts_with("```") || trimmed.starts_with("~~~"))
            }) {
                return Err(refusal("a cell would end the sheet block"));
            }
            rows = rows.max(row);
            columns = columns.max(col);
            formulas += usize::from(source.starts_with('='));
            cells.push(SheetCellSource { row, col, source });
        }
        summaries.push(SheetSummary {
            name: ws.name.clone(),
            rows,
            columns,
            filled: cells.len(),
            formulas,
            hidden,
        });
        sources.push(SheetInput {
            name: ws.name.clone(),
            cells,
        });
    }
    engine::check_workbook(&sources)?;
    let body = sources
        .iter()
        .map(|sheet| edit::new_fence(sheet, "\n"))
        .collect::<Vec<_>>()
        .join("\n");
    let readback: Vec<_> = fence::read_fences(&body)
        .into_iter()
        .map(|f| f.input().ok_or_else(corrupt))
        .collect::<Result<_, _>>()?;
    let round = engine::build_model(thread, &readback, tz)?;
    let compare = round.model.get_model();
    let all: BTreeSet<_> = positions(&model)
        .into_iter()
        .chain(positions(compare))
        .collect();
    for (sheet, row, col) in all {
        if volatile.contains(&(sheet, row, col)) {
            continue;
        }
        let before = value(&model, sheet, row, col)?;
        let after = value(compare, sheet, row, col)?;
        if !equal(&before, &after) {
            report.changed.count += 1;
            if report.changed.first.len() < 3 {
                report.changed.first.push(Difference {
                    cell: address(&sources[sheet as usize].name, row, col),
                    before: before.text,
                    after: after.text,
                });
            }
        }
    }
    for ((sheet, row, col), before) in saved {
        report.saved.compared += 1;
        let after = value(&model, sheet, row, col)?;
        if !equal(&before, &after) {
            report.saved.differ += 1;
            if report.saved.first.len() < 3 {
                report.saved.first.push(Difference {
                    cell: address(&sources[sheet as usize].name, row, col),
                    before: before.text,
                    after: after.text,
                });
            }
        }
    }
    Ok(XlsxImport {
        body,
        sheets: summaries,
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::File, io::Cursor};
    const EXAMPLE: &[u8] = include_bytes!("../../fixtures/sheets/ironcalc-example.xlsx");
    fn example() -> XlsxImport {
        engine::run_on_engine_thread(|thread| decode_xlsx(thread, EXAMPLE, "example", "UTC"))
            .unwrap()
    }
    fn archive(parts: &[(&str, &[u8])]) -> Vec<u8> {
        crate::files::extract::testdocs::package(parts)
    }
    fn export_body() -> String {
        let first = SheetInput {
            name: "Budget".into(),
            cells: vec![
                SheetCellSource {
                    row: 1,
                    col: 1,
                    source: "42".into(),
                },
                SheetCellSource {
                    row: 1,
                    col: 2,
                    source: "25%".into(),
                },
                SheetCellSource {
                    row: 2,
                    col: 1,
                    source: "'00123".into(),
                },
                SheetCellSource {
                    row: 3,
                    col: 1,
                    source: "two\nlines".into(),
                },
                SheetCellSource {
                    row: 4,
                    col: 2,
                    source: "=A1*2".into(),
                },
                SheetCellSource {
                    row: 5,
                    col: 1,
                    source: "2026-10-15".into(),
                },
            ],
        };
        let second = SheetInput {
            name: "Summary".into(),
            cells: vec![SheetCellSource {
                row: 1,
                col: 1,
                source: "=Budget!B4".into(),
            }],
        };
        format!(
            "{}\n{}",
            edit::new_fence(&first, "\n"),
            edit::new_fence(&second, "\n")
        )
    }
    #[test]
    fn an_exported_page_imports_back_to_the_same_sources() {
        let body = export_body();
        let bytes = workbook_xlsx(body.clone(), "UTC".into()).unwrap();
        let imported = engine::run_on_engine_thread(move |thread| {
            decode_xlsx(thread, &bytes, "export", "UTC")
        })
        .unwrap();
        assert_eq!(imported.report.changed.count, 0);
        assert_eq!(imported.report.saved.differ, 0);
        assert_eq!(imported.report.saved.compared, 2);
        let original = fence::read_fences(&body);
        let again = fence::read_fences(&imported.body);
        assert_eq!(original.len(), again.len());
        for (before, after) in original.iter().zip(&again) {
            let mut before = before.input().unwrap();
            let mut after = after.input().unwrap();
            // Dates may normalize their display spelling; their value is held
            // by the decoder's whole-workbook comparison above.
            before.cells.retain(|c| !(c.row == 5 && c.col == 1));
            after.cells.retain(|c| !(c.row == 5 && c.col == 1));
            assert_eq!(
                serde_json::to_value(before).unwrap(),
                serde_json::to_value(after).unwrap()
            );
        }
        assert!(imported.body.contains("'00123"));
        assert!(imported.body.contains("25%"));
        assert!(imported.body.contains("\"two\nlines\""));
    }
    #[test]
    fn exported_formulas_keep_their_values() {
        let bytes = workbook_xlsx(export_body(), "UTC".into()).unwrap();
        engine::run_on_engine_thread(move |_| {
            let workbook =
                ironcalc::import::load_from_xlsx_bytes(&bytes, "export", "en", "UTC").unwrap();
            let model = Model::from_workbook(workbook, "en").unwrap();
            assert_eq!(model.get_formatted_cell_value(0, 4, 2).unwrap(), "84");
            assert_eq!(model.get_formatted_cell_value(1, 1, 1).unwrap(), "84");
            assert_eq!(
                model.get_cell_formula(1, 1, 1).unwrap(),
                Some("=Budget!B4".into())
            );
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn a_page_without_sheets_is_refused() {
        assert_eq!(
            workbook_xlsx("# No sheets\n".into(), "UTC".into()).unwrap_err(),
            "This page has no sheets to export."
        );
    }
    #[test]
    fn an_unreadable_sheet_is_refused_by_name() {
        for body in [
            "```cerebro-sheet\n---\nname: Broken\nformat: 2\n---\n1\n```\n",
            "```cerebro-sheet\n---\nname: Broken\n---\n1\n",
        ] {
            let error = workbook_xlsx(body.into(), "UTC".into()).unwrap_err();
            assert!(
                error.starts_with("“Sheet1” can't be read, so nothing was exported:"),
                "{error}"
            );
        }
        let duplicate = format!(
            "{}\n{}",
            edit::new_fence(
                &SheetInput {
                    name: "Same".into(),
                    cells: vec![]
                },
                "\n"
            ),
            edit::new_fence(
                &SheetInput {
                    name: "Same".into(),
                    cells: vec![]
                },
                "\n"
            )
        );
        assert!(workbook_xlsx(duplicate, "UTC".into())
            .unwrap_err()
            .contains("nothing was exported"));
    }
    #[test]
    fn the_upstream_example_imports_with_its_formulas() {
        let result = example();
        assert_eq!(
            result
                .sheets
                .iter()
                .map(|s| s.name.as_str())
                .collect::<Vec<_>>(),
            [
                "Sheet1",
                "Second",
                "Sheet4",
                "shared",
                "Table",
                "Sheet2",
                "Created fourth",
                "Frozen",
                "Split",
                "Hidden"
            ]
        );
        for source in [
            "=Sheet1!$C$14",
            "=SUM(Sheet1!$A$16:$A$18)",
            "=SUM(Second!$B$1:$B$9)",
        ] {
            assert!(result.body.contains(source), "{source}\n{}", result.body);
        }
        assert_eq!(
            result.report.changed.count, 0,
            "{:?}",
            result.report.changed
        );
    }
    #[test]
    fn the_report_names_what_stays_behind() {
        let r = example().report;
        assert_eq!(
            (
                r.charts,
                r.chart_sheets,
                r.pivots,
                r.images,
                r.tables,
                r.hidden,
                r.names_inlined
            ),
            (2, 1, 1, 0, 1, 1, 3)
        );
        assert!(r.names_left.is_empty());
        assert!(r.formatting);
        assert!(r.notes > 0);
        assert!(r.saved.compared > 0);
    }
    #[test]
    fn archive_limits_aliases_and_encryption_refuse_before_import() {
        assert!(check_archive(b"not a zip")
            .unwrap_err()
            .contains("valid, unencrypted"));
        let zip = archive(&[("xl/a.xml", b"a"), ("/XL/A.XML", b"b")]);
        assert!(check_archive(&zip).unwrap_err().contains("share a name"));
        let zip = archive(&[("xl/a.xml", &[b'x'; 50])]);
        assert!(check_archive_limits(&zip, PART_CAP, 10)
            .unwrap_err()
            .contains("expand past"));
        assert!(check_archive_limits(&zip, 0, EXPANDED_CAP)
            .unwrap_err()
            .contains("10,000 parts"));
        let mut encrypted = zip;
        for at in 0..encrypted.len() - 8 {
            if encrypted[at..].starts_with(b"PK\x01\x02") {
                encrypted[at + 8] |= 1;
            }
            if encrypted[at..].starts_with(b"PK\x03\x04") {
                encrypted[at + 6] |= 1;
            }
        }
        assert!(check_archive(&encrypted)
            .unwrap_err()
            .contains("valid, unencrypted"));
    }
    #[test]
    fn archive_preflight_bounds_array_expansion_before_the_importer_allocates() {
        for (range, problem) in [
            ("A1:XFD1048576", "extends beyond"),
            ("A1:Z500", "expand beyond"),
        ] {
            let xml=format!("<worksheet><sheetData><row><c r=\"A1\"><f t=\"array\" ref=\"{range}\">1</f></c></row></sheetData></worksheet>");
            let bytes = archive(&[("xl/worksheets/sheet1.xml", xml.as_bytes())]);
            assert!(check_archive(&bytes).unwrap_err().contains(problem));
        }
        // A qualified decoy must never hide the dangerous unqualified ref.
        let xml=br#"<worksheet xmlns:x="urn:x"><f t="array" ref="A1:XFD1048576" x:ref="A1"/></worksheet>"#;
        assert!(
            check_archive(&archive(&[("xl/worksheets/sheet1.xml", xml)]))
                .unwrap_err()
                .contains("extends beyond")
        );
        let xml =
            br#"<worksheet><f t="array" ref="A1:T300"/><f t="array" ref="A1:T300"/></worksheet>"#;
        assert!(
            check_archive(&archive(&[("xl/worksheets/sheet1.xml", xml)]))
                .unwrap_err()
                .contains("expand beyond")
        );
    }
    #[test]
    fn archive_preflight_refuses_string_amplification_and_silent_zero_coercion() {
        for (xml, problem) in [
            ("<sst><si><si><t>text</t></si></si></sst>", "nested"),
            (
                "<worksheet><is><is><t>text</t></is></is></worksheet>",
                "nested",
            ),
            (
                "<worksheet><c t=\"n\"><v>garbage</v></c></worksheet>",
                "numeric",
            ),
            ("<worksheet><c t=\"n\"/></worksheet>", "numeric"),
            ("<worksheet><c><v>NaN</v></c></worksheet>", "numeric"),
            (
                "<worksheet><c t=\"b\"><v>maybe</v></c></worksheet>",
                "boolean",
            ),
        ] {
            let bytes = archive(&[("xl/worksheets/sheet1.xml", xml.as_bytes())]);
            assert!(
                check_archive(&bytes).unwrap_err().contains(problem),
                "{xml}"
            );
        }
        let text = format!("<sst><si><t>{}</t></si></sst>", "x".repeat(10_001));
        assert!(
            check_archive(&archive(&[("xl/sharedStrings.xml", text.as_bytes())]))
                .unwrap_err()
                .contains("10,000 characters")
        );
    }
    #[test]
    fn the_archive_scan_counts_parts_without_counting_chart_styles() {
        let zip = archive(&[
            ("xl/charts/chart1.xml", b"<chartSpace/>"),
            ("xl/charts/style1.xml", b"<x/>"),
            ("xl/charts/colors1.xml", b"<x/>"),
            ("xl/charts/chartStyle.xml", b"<chartStyle/>"),
            ("xl/chartsheets/sheet1.xml", b"<x/>"),
            ("xl/media/image1.png", b"x"),
            ("xl/pivotTables/pivotTable1.xml", b"<x/>"),
            ("xl/externalLinks/externalLink1.xml", b"<x/>"),
            ("xl/vbaProject.bin", b"x"),
        ]);
        let r = check_archive(&zip).unwrap();
        assert_eq!(
            (
                r.charts,
                r.chart_sheets,
                r.images,
                r.pivots,
                r.external_links
            ),
            (1, 1, 1, 1, 1)
        );
        assert!(r.macros);
    }
    #[test]
    fn typed_text_formats_and_spills_keep_their_source_semantics() {
        engine::run_on_engine_thread(|thread| {
            let mut model = Model::new_empty("test", "en", "UTC", "en")?;
            for (row, input) in [
                "'00123",
                "'=1+2",
                "'TRUE",
                "'25%",
                "25%",
                "123.123456789123",
                "=SEQUENCE(2,1)",
            ]
            .iter()
            .enumerate()
            {
                model.set_user_input(0, row as i32 + 1, 1, (*input).into())?;
            }
            model.evaluate();
            let mut probe = Model::new_empty("probe", "en", "UTC", "en")?;
            let mut r = ImportReport::default();
            for (row, expected) in [
                "'00123",
                "'=1+2",
                "'TRUE",
                "'25%",
                "25%",
                "123.123456789123",
                "=SEQUENCE(2,1)",
                "",
            ]
            .iter()
            .enumerate()
            {
                assert_eq!(
                    source_of(thread, &model, &mut probe, 0, row as i32 + 1, 1, &mut r)?,
                    *expected
                );
            }
            assert!(r.formats_lost > 0);
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn saved_values_compare_and_volatile_formulas_are_skipped() {
        engine::run_on_engine_thread(|thread| {
            let mut model = Model::new_empty("test", "en", "UTC", "en")?;
            model.set_user_input(0, 1, 1, "=1+2".into())?;
            model.set_user_input(0, 2, 1, "=TODAY()".into())?;
            model.evaluate();
            if let Some(Cell::CellFormula { v, .. }) = model.workbook.worksheets[0]
                .sheet_data
                .get_mut(&1)
                .and_then(|r| r.get_mut(&1))
            {
                *v = FormulaValue::Number(99.0);
            }
            let bytes = ironcalc::export::save_xlsx_to_writer(&model, Cursor::new(Vec::new()))
                .unwrap()
                .into_inner();
            let result = decode_xlsx(thread, &bytes, "test", "UTC")?;
            assert_eq!(result.report.saved.compared, 1);
            assert_eq!(result.report.saved.differ, 1);
            assert_eq!(result.report.saved.volatile, 1);
            assert_eq!(result.report.saved.first[0].before, "99");
            assert_eq!(result.report.saved.first[0].after, "3");
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn a_formula_without_a_numeric_cache_is_unsaved_not_zero() {
        use crate::files::extract::{package::Package, Limits};
        let bytes = workbook_xlsx(export_body(), "UTC".into()).unwrap();
        let mut package = Package::new(bytes, "xlsx", Limits::SHIPPED).unwrap();
        let mut parts = Vec::new();
        for name in package.names() {
            let mut bytes = package.read_part(&name, FILE_CAP).unwrap();
            if name.starts_with("xl/worksheets/") && name.ends_with(".xml") {
                let xml = String::from_utf8(bytes).unwrap();
                bytes = xml.replace("<v>84</v>", "").into_bytes();
            }
            parts.push((name, bytes));
        }
        let refs: Vec<_> = parts
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
            .collect();
        let bytes = archive(&refs);
        let result = engine::run_on_engine_thread(move |thread| {
            decode_xlsx(thread, &bytes, "uncached", "UTC")
        })
        .unwrap();
        assert_eq!(result.report.saved.unsaved, 2);
        assert_eq!(result.report.saved.compared, 0);
        assert_eq!(result.report.saved.differ, 0);
        assert_eq!(result.report.changed.count, 0);
    }
    #[test]
    fn complex_names_are_left_and_listed_and_caps_refuse_by_sheet() {
        engine::run_on_engine_thread(|thread| {
            let mut model = Model::new_empty("test", "en", "UTC", "en")?;
            model
                .workbook
                .defined_names
                .push(ironcalc_base::types::DefinedName {
                    name: "complex".into(),
                    formula: "SUM(Sheet1!$A$1:$A$2)".into(),
                    sheet_id: None,
                });
            let mut model = Model::from_workbook(model.workbook, "en")?;
            model.set_user_input(0, 1, 2, "=complex+1".into())?;
            let mut report = ImportReport::default();
            assert_eq!(
                inline_names(&model, "=complex+1", 0, 1, 2, &mut report),
                "=complex+1"
            );
            assert_eq!(report.names_left, ["complex"]);
            model.set_user_input(0, 501, 1, "1".into())?;
            model.evaluate();
            let bytes = ironcalc::export::save_xlsx_to_writer(&model, Cursor::new(Vec::new()))
                .unwrap()
                .into_inner();
            assert!(decode_xlsx(thread, &bytes, "test", "UTC")
                .unwrap_err()
                .contains("“Sheet1” spans 501"));
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn picked_csv_is_exact_bytes_and_special_oversized_and_other_files_refuse() {
        let root = crate::vault::testutil::temp_vault("sheet-pick");
        let path = root.join("values.csv");
        let bytes = b"\xef\xbb\xbf00123,\"a\r\nb\"\r\n";
        std::fs::write(&path, bytes).unwrap();
        let PickedSheet::Csv { name, bytes_base64 } = read_sheet_file(&path, "UTC").unwrap() else {
            panic!("csv")
        };
        assert_eq!(name, "values.csv");
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(bytes_base64)
                .unwrap(),
            bytes
        );
        assert!(read_sheet_file(&root, "UTC")
            .unwrap_err()
            .contains("regular file"));
        let large = root.join("large.xlsx");
        File::create(&large).unwrap().set_len(FILE_CAP + 1).unwrap();
        assert_eq!(
            read_sheet_file(&large, "UTC").unwrap_err(),
            "Choose a file up to 32 MB."
        );
        let other = root.join("other.txt");
        std::fs::write(&other, "x").unwrap();
        assert!(read_sheet_file(&other, "UTC")
            .unwrap_err()
            .contains("imports .xlsx"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_parser_input_refuses_in_words_and_the_engine_thread_lives() {
        let bytes = archive(&[("xl/sharedStrings.xml", b"<not xml")]);
        let result =
            engine::run_on_engine_thread(move |thread| decode_xlsx(thread, &bytes, "bad", "UTC"));
        assert!(result.unwrap_err().contains("This isn't an Excel workbook"));
        assert_eq!(engine::run_on_engine_thread(|_| Ok(7)).unwrap(), 7);
    }
    #[test]
    #[ignore = "Regenerates the reviewed upstream workbook decode; see fixtures/sheets/README.md"]
    fn writes_the_recorded_decode() {
        let text = serde_json::to_string_pretty(&example()).unwrap() + "\n";
        std::fs::write(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("fixtures/sheets/ironcalc-example.decoded.json"),
            text,
        )
        .unwrap();
    }
    #[test]
    fn the_recorded_decode_is_current() {
        assert_eq!(
            serde_json::to_string_pretty(&example()).unwrap() + "\n",
            include_str!("../../fixtures/sheets/ironcalc-example.decoded.json")
        );
    }
}
