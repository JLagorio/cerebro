//! Sparse, streaming workbook reads. No dense worksheet API is called here.
use super::{
    package::Package, CellValue, Document, Failure, Limits, Parsed, Picture, PicturePlace, Sheet,
};
use calamine::{DataRef, Reader, SheetType, SheetVisible, Xlsx};
use std::{collections::BTreeMap, io::Cursor};

pub fn column_name(mut n: u32) -> String {
    let mut out = Vec::new();
    loop {
        out.push((b'A' + (n % 26) as u8) as char);
        if n < 26 {
            break;
        }
        n = n / 26 - 1;
    }
    out.into_iter().rev().collect()
}
pub fn address(pos: (u32, u32)) -> String {
    format!("{}{}", column_name(pos.1), pos.0 + 1)
}
pub fn range_name(used: Option<((u32, u32), (u32, u32))>) -> String {
    used.map(|(a, b)| {
        if a == b {
            address(a)
        } else {
            format!("{}:{}", address(a), address(b))
        }
    })
    .unwrap_or_else(|| "none".into())
}
fn value(value: &DataRef<'_>) -> CellValue {
    match value {
        DataRef::Int(n) => CellValue::Number(*n as f64),
        DataRef::Float(n) => {
            if n.is_finite() {
                CellValue::Number(*n)
            } else {
                CellValue::Error("non-finite number".into())
            }
        }
        DataRef::String(s) | DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => match value {
            DataRef::DateTimeIso(_) => CellValue::Date(s.clone()),
            DataRef::DurationIso(_) => CellValue::Duration(s.clone()),
            _ => CellValue::Text(s.clone()),
        },
        DataRef::SharedString(s) => CellValue::Text((*s).into()),
        DataRef::Bool(b) => CellValue::Bool(*b),
        DataRef::DateTime(date) => date
            .as_datetime()
            .map(|d| {
                CellValue::Date(if d.time() == chrono::NaiveTime::MIN {
                    d.date().to_string()
                } else {
                    d.format("%Y-%m-%dT%H:%M:%S").to_string()
                })
            })
            .unwrap_or_else(|| CellValue::Error("invalid date".into())),
        DataRef::Error(error) => CellValue::Error(error.to_string()),
        DataRef::Empty => CellValue::Empty,
    }
}
/// Calamine reserves from SST uniqueCount and resizes from shared-formula si.
/// Both are attacker-controlled integers; bound them before library construction.
fn preflight(package: &mut Package, limits: Limits) -> Result<(), Failure> {
    for part in package.names().into_iter().filter(|n| n.ends_with(".xml")) {
        let root = package.xml(&part)?;
        for sst in root.descendants("sst") {
            if sst.raw_attr("uniqueCount").is_some_and(|s| {
                s.parse::<usize>()
                    .map_or(true, |n| n > limits.scanned_cells)
            }) {
                return Err(Failure::too_large(
                    "the shared-string count exceeds the cell limit",
                ));
            }
            if sst.descendants("si").count() > limits.scanned_cells {
                return Err(Failure::too_large(
                    "the shared-string count exceeds the cell limit",
                ));
            }
        }
        for formula in root.descendants("f") {
            if formula.raw_attr("si").is_some_and(|s| {
                s.parse::<usize>()
                    .map_or(true, |n| n >= limits.scanned_cells)
            }) {
                return Err(Failure::too_large(
                    "a shared-formula index exceeds the cell limit",
                ));
            }
        }
    }
    Ok(())
}
pub fn read(package: &mut Package, limits: Limits) -> Result<Parsed, Failure> {
    preflight(package, limits)?;
    let part = package.office_part("xl/workbook.xml")?;
    let root = package.xml(&part)?;
    let relationships = package.relationships(&part)?;
    let sheet_parts: BTreeMap<String, String> = root
        .descendants("sheet")
        .filter_map(|node| {
            let name = node.attr("name")?;
            let rel = relationships.get(node.attr("id")?)?;
            (rel.kind == "worksheet" && !rel.external)
                .then(|| (name.to_owned(), rel.target.clone()))
        })
        .collect();
    let mut workbook = Xlsx::new(Cursor::new(package.bytes()))
        .map_err(|_| Failure::corrupt("the workbook could not be read"))?;
    let metadata = workbook.sheets_metadata().to_vec();
    let mut sheets = Vec::new();
    let mut pictures = Vec::new();
    let mut scanned = 0_usize;
    let mut materialized = 0_u64;
    for meta in metadata {
        if meta.typ != SheetType::WorkSheet {
            continue;
        }
        let mut reader = workbook
            .worksheet_cells_reader(&meta.name)
            .map_err(|_| Failure::corrupt(format!("sheet \"{}\" could not be read", meta.name)))?;
        let mut cells = BTreeMap::new();
        let mut formulas = BTreeMap::new();
        let mut used: Option<((u32, u32), (u32, u32))> = None;
        while let Some(cell) = reader
            .next_cell_with_formula()
            .map_err(|_| Failure::corrupt("a workbook cell could not be read"))?
        {
            scanned += 1;
            if scanned > limits.scanned_cells {
                return Err(Failure::too_large(
                    "the workbook has more than 2,000,000 cells to scan",
                ));
            }
            if cell.pos.0 >= 1_048_576 || cell.pos.1 >= 16_384 {
                return Err(Failure::corrupt(
                    "a cell is outside Excel's rows or columns",
                ));
            }
            let text_bytes = match &cell.value {
                DataRef::String(s) | DataRef::DateTimeIso(s) | DataRef::DurationIso(s) => s.len(),
                DataRef::SharedString(s) => s.len(),
                _ => 32,
            };
            // A single large SST string may be referenced by millions of tiny
            // cells. Check before cloning it, and include map/node overhead.
            let bytes = (text_bytes as u64)
                .saturating_add(cell.formula.as_ref().map_or(0, |s| s.len() as u64))
                .saturating_add(128);
            materialized = materialized.saturating_add(bytes);
            if materialized > limits.total_parts_bytes {
                return Err(Failure::too_large(
                    "the materialized workbook exceeds its memory limit",
                ));
            }
            let val = value(&cell.value);
            if val != CellValue::Empty || cell.formula.is_some() {
                used = Some(match used {
                    None => (cell.pos, cell.pos),
                    Some((a, b)) => (
                        (a.0.min(cell.pos.0), a.1.min(cell.pos.1)),
                        (b.0.max(cell.pos.0), b.1.max(cell.pos.1)),
                    ),
                });
                cells.insert(cell.pos, val);
            }
            if let Some(formula) = cell.formula {
                formulas.insert(cell.pos, formula);
            }
        }
        drop(reader);
        sheets.push(Sheet {
            name: meta.name,
            hidden: meta.visible != SheetVisible::Visible,
            used,
            cells,
            formulas,
            merges: Vec::new(),
        });
    }
    // Release the workbook's borrow of the compressed bytes before further
    // bounded package reads for drawings and merged regions.
    drop(workbook);
    for sheet in &mut sheets {
        let mut merges = Vec::new();
        if let Some(path) = sheet_parts.get(&sheet.name) {
            let xml = package.xml(path)?;
            merges = xml
                .descendants("mergeCell")
                .filter_map(|n| n.attr("ref").map(str::to_owned))
                .collect();
            for drawing in package
                .relationships(path)?
                .values()
                .filter(|r| r.kind == "drawing" && !r.external)
            {
                let root = package.xml(&drawing.target)?;
                let rels = package.relationships(&drawing.target)?;
                for anchor in &root.children {
                    let from = anchor.child("from");
                    let row = from
                        .and_then(|n| n.child("row"))
                        .and_then(|n| n.text.parse::<u32>().ok())
                        .unwrap_or(0);
                    let column = from
                        .and_then(|n| n.child("col"))
                        .and_then(|n| n.text.parse::<u32>().ok())
                        .unwrap_or(0);
                    if row >= 1_048_576 || column >= 16_384 {
                        return Err(Failure::corrupt(
                            "a picture anchor is outside Excel's rows or columns",
                        ));
                    }
                    for pic in anchor.descendants("pic") {
                        let alt = pic
                            .descendants("cNvPr")
                            .next()
                            .and_then(|n| n.attr("descr").or_else(|| n.attr("title")))
                            .unwrap_or("");
                        for blip in pic.descendants("blip") {
                            if let Some(rel) = blip
                                .attr("embed")
                                .and_then(|id| rels.get(id))
                                .filter(|r| r.kind == "image" && !r.external)
                            {
                                materialized = materialized
                                    .saturating_add(128)
                                    .saturating_add(rel.target.len() as u64)
                                    .saturating_add(alt.len() as u64)
                                    .saturating_add(sheet.name.len() as u64);
                                if materialized > limits.total_parts_bytes {
                                    return Err(Failure::too_large(
                                        "the materialized workbook exceeds its memory limit",
                                    ));
                                }
                                pictures.push(Picture {
                                    part: rel.target.clone(),
                                    alt: alt.into(),
                                    place: PicturePlace::Workbook {
                                        sheet: sheet.name.clone(),
                                        anchor: address((row, column)),
                                    },
                                });
                            }
                        }
                    }
                }
            }
        }
        sheet.merges = merges;
    }
    Ok((Document::Workbook(sheets), pictures, Vec::new()))
}
pub fn formulas_in(sheet: &Sheet, start: (u32, u32), end: (u32, u32)) -> Vec<((u32, u32), &str)> {
    sheet
        .formulas
        .iter()
        .filter(|(p, _)| p.0 >= start.0 && p.0 <= end.0 && p.1 >= start.1 && p.1 <= end.1)
        .take(200)
        .map(|(p, s)| (*p, s.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::extract::{self, testdocs, Format};
    #[test]
    fn typed_values_dates_hidden_sheets_and_merged_ranges_are_read() {
        let doc = extract::open(testdocs::xlsx(), Format::Xlsx, Limits::SHIPPED).unwrap();
        let Document::Workbook(sheets) = &doc.document else {
            panic!("workbook");
        };
        let sheet = &sheets[0];
        assert!(sheet.hidden);
        assert_eq!(range_name(sheet.used), "A1:C2");
        assert_eq!(sheet.cells[&(0, 0)], CellValue::Text("Name".into()));
        assert_eq!(sheet.cells[&(0, 1)], CellValue::Number(4.0));
        assert_eq!(sheet.cells[&(0, 2)], CellValue::Bool(true));
        assert_eq!(sheet.cells[&(1, 0)], CellValue::Date("2024-01-01".into()));
        assert_eq!(sheet.formulas[&(1, 1)], "B1*2");
        assert_eq!(sheet.merges, ["A3:B3"]);
    }
    #[test]
    fn a_far_sparse_cell_allocates_nothing() {
        let bytes = testdocs::xlsx_cells(
            r#"<row r="1"><c r="A1"><v>1</v></c></row><row r="1048576"><c r="XFD1048576"><v>2</v></c></row>"#,
            "",
        );
        let doc = extract::open(bytes, Format::Xlsx, Limits::SHIPPED).unwrap();
        let Document::Workbook(sheets) = doc.document else {
            panic!("workbook");
        };
        assert_eq!(sheets[0].cells.len(), 2);
        assert_eq!(range_name(sheets[0].used), "A1:XFD1048576");
    }
    #[test]
    fn formulas_stop_at_200() {
        let cells = (1..=205)
            .map(|r| format!("<row r=\"{r}\"><c r=\"A{r}\"><f>1+1</f><v>2</v></c></row>"))
            .collect::<String>();
        let doc = extract::open(
            testdocs::xlsx_cells(&cells, ""),
            Format::Xlsx,
            Limits::SHIPPED,
        )
        .unwrap();
        let Document::Workbook(sheets) = &doc.document else {
            panic!("workbook");
        };
        assert_eq!(formulas_in(&sheets[0], (0, 0), (204, 0)).len(), 200);
    }
    #[test]
    fn a_shared_formula_cannot_allocate_by_an_untrusted_index() {
        let bytes = testdocs::xlsx_cells(
            r#"<row><c r="A1"><f t="shared" si="4294967294">1</f><v>1</v></c></row>"#,
            "",
        );
        assert!(matches!(
            extract::open(bytes, Format::Xlsx, Limits::SHIPPED),
            Err(Failure::TooLarge { .. })
        ));
    }
    #[test]
    fn namespaced_attributes_cannot_hide_allocation_counts() {
        for xml in [
            r#"<sst xmlns:x="urn:x" uniqueCount="4294967294" x:uniqueCount="0"/>"#,
            r#"<wrapper><sst uniqueCount="4294967294"/></wrapper>"#,
            r#"<worksheet xmlns:x="urn:x"><f si="4294967294" x:si="0">1</f></worksheet>"#,
        ] {
            let mut p = Package::new(
                testdocs::package(&[("part.xml", xml.as_bytes())]),
                "xlsx",
                Limits::SHIPPED,
            )
            .unwrap();
            assert!(
                matches!(
                    preflight(&mut p, Limits::SHIPPED),
                    Err(Failure::TooLarge { .. })
                ),
                "{xml}"
            );
        }
    }
    #[test]
    fn repeated_shared_strings_cannot_amplify_past_the_memory_budget() {
        let cells = (1..=32)
            .map(|row| format!("<row><c r=\"A{row}\" t=\"s\"><v>0</v></c></row>"))
            .collect::<String>();
        let shared = format!("<sst xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" uniqueCount=\"1\"><si><t>{}</t></si></sst>","x".repeat(4096));
        let bytes = testdocs::xlsx_shared(&cells, "", &shared);
        let result = extract::open(
            bytes,
            Format::Xlsx,
            Limits {
                total_parts_bytes: 20_000,
                ..Limits::SHIPPED
            },
        );
        assert!(
            matches!(result,Err(Failure::TooLarge{detail}) if detail.contains("materialized workbook"))
        );
    }
}
