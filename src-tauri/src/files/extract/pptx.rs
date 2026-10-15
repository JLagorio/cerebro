//! Slides in presentation order, including body notes and named non-text content.
use super::{
    materialize::Budget,
    package::{Package, Relationship},
    xml::Node,
    Block, Document, Failure, Inline, Limits, Parsed, Picture, PicturePlace, Slide, TableCell,
};
use std::collections::BTreeMap;

fn text(node: &Node) -> String {
    node.descendants("t")
        .map(|n| n.text.as_str())
        .collect::<Vec<_>>()
        .join("")
}
fn paragraphs(node: &Node, budget: &mut Budget) -> Result<Vec<Block>, Failure> {
    node.descendants("p")
        .filter_map(|p| {
            let value = text(p);
            if value.is_empty() {
                return None;
            }
            let props = p.child("pPr");
            let level = props
                .and_then(|n| n.attr("lvl"))
                .and_then(|s| s.parse::<u8>().ok())
                .unwrap_or(0)
                .min(8);
            let bullet = props
                .and_then(|n| n.child("buChar"))
                .and_then(|n| n.attr("char"));
            let block = if let Some(label) = bullet {
                Block::List {
                    level,
                    label: label.into(),
                    runs: vec![Inline::text(value)],
                }
            } else if let Some(auto) = props.and_then(|n| n.child("buAutoNum")) {
                Block::List {
                    level,
                    label: format!("{}.", auto.attr("startAt").unwrap_or("1")),
                    runs: vec![Inline::text(value)],
                }
            } else {
                Block::Paragraph {
                    runs: vec![Inline::text(value)],
                }
            };
            Some(budget.block(&block).map(|()| block))
        })
        .collect()
}
fn shape_title(node: &Node) -> bool {
    node.descendants("ph")
        .any(|n| matches!(n.attr("type"), Some("title" | "ctrTitle")))
}
fn visit(
    node: &Node,
    rels: &BTreeMap<String, Relationship>,
    slide: usize,
    blocks: &mut Vec<Block>,
    pictures: &mut Vec<Picture>,
    budget: &mut Budget,
) -> Result<(), Failure> {
    match node.name.as_str() {
        "sp" => {
            if !shape_title(node) {
                blocks.extend(paragraphs(node, budget)?);
            }
        }
        "pic" => {
            let alt = node
                .descendants("cNvPr")
                .next()
                .and_then(|n| n.attr("descr").or_else(|| n.attr("title")))
                .unwrap_or("");
            for blip in node.descendants("blip") {
                if let Some(rel) = blip
                    .attr("embed")
                    .and_then(|id| rels.get(id))
                    .filter(|r| r.kind == "image" && !r.external)
                {
                    budget.charge(
                        (alt.len() as u64)
                            .saturating_add(rel.target.len() as u64)
                            .saturating_mul(2)
                            .saturating_add(256),
                    )?;
                    pictures.push(Picture {
                        part: rel.target.clone(),
                        alt: alt.into(),
                        place: PicturePlace::Slide { slide },
                    });
                    blocks.push(Block::Picture {
                        alt: alt.into(),
                        part: rel.target.clone(),
                    });
                }
            }
        }
        "tbl" => {
            budget.charge(128)?;
            let mut rows = Vec::new();
            for row in node.children.iter().filter(|n| n.name == "tr") {
                budget.charge(32)?;
                let mut cells = Vec::new();
                for cell in row.children.iter().filter(|n| n.name == "tc") {
                    budget.charge(64)?;
                    let mut text = String::new();
                    for paragraph in cell.descendants("p") {
                        if !text.is_empty() {
                            budget.charge(1)?;
                            text.push('\n');
                        }
                        for run in paragraph.descendants("t") {
                            budget.charge(run.text.len() as u64)?;
                            text.push_str(&run.text);
                        }
                    }
                    cells.push(TableCell {
                        text,
                        colspan: cell
                            .attr("gridSpan")
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(1_usize)
                            .clamp(1, 16_384),
                        rowspan: if cell.attr("vMerge") == Some("1") {
                            0
                        } else {
                            cell.attr("rowSpan")
                                .and_then(|s| s.parse().ok())
                                .unwrap_or(1_usize)
                                .clamp(1, 1_048_576)
                        },
                    });
                }
                rows.push(cells);
            }
            blocks.push(Block::Table { rows });
        }
        "chart" => {
            let name = node
                .attr("id")
                .and_then(|id| rels.get(id))
                .map(|r| r.target.clone())
                .unwrap_or_else(|| "Chart".into());
            let block = Block::Chart { name };
            budget.block(&block)?;
            blocks.push(block);
        }
        _ => {
            for child in &node.children {
                visit(child, rels, slide, blocks, pictures, budget)?;
            }
        }
    }
    Ok(())
}
pub fn read(package: &mut Package, limits: Limits) -> Result<Parsed, Failure> {
    let part = package.office_part("ppt/presentation.xml")?;
    let root = package.xml(&part)?;
    let rels = package.relationships(&part)?;
    let mut slides = Vec::new();
    let mut pictures = Vec::new();
    let mut budget = Budget::new(limits.total_parts_bytes);
    for slide_id in root.descendants("sldId") {
        let id = slide_id
            .attr("id")
            .ok_or_else(|| Failure::corrupt("a slide has no relationship"))?;
        let rel = rels
            .get(id)
            .filter(|r| r.kind == "slide" && !r.external)
            .ok_or_else(|| Failure::corrupt("a slide relationship is missing"))?;
        let slide_root = package.xml(&rel.target)?;
        let slide_rels = package.relationships(&rel.target)?;
        let title = slide_root
            .descendants("sp")
            .find(|n| shape_title(n))
            .map(text)
            .unwrap_or_default();
        let mut blocks = Vec::new();
        visit(
            &slide_root,
            &slide_rels,
            slides.len() + 1,
            &mut blocks,
            &mut pictures,
            &mut budget,
        )?;
        let mut notes = Vec::new();
        for rel in slide_rels
            .values()
            .filter(|r| r.kind == "notesSlide" && !r.external)
        {
            let root = package.xml(&rel.target)?;
            for shape in root
                .descendants("sp")
                .filter(|n| n.descendants("ph").any(|p| p.attr("type") == Some("body")))
            {
                for p in shape.descendants("p") {
                    let words = text(p);
                    if !words.is_empty() {
                        budget.charge(words.len() as u64 + 32)?;
                        notes.push(words);
                    }
                }
            }
        }
        budget.charge(title.len() as u64 + 128)?;
        slides.push(Slide {
            title,
            hidden: slide_root
                .attr("show")
                .is_some_and(|v| matches!(v, "0" | "false")),
            blocks,
            notes: notes.join("\n"),
        });
    }
    Ok((Document::Presentation(slides), pictures, Vec::new()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::extract::{self, testdocs, Format, Limits};
    #[test]
    fn deck_order_titles_hidden_bullets_and_body_notes_are_carried() {
        let doc = extract::open(testdocs::pptx(), Format::Pptx, Limits::SHIPPED).unwrap();
        let Document::Presentation(slides) = &doc.document else {
            panic!("deck");
        };
        assert_eq!(slides.len(), 3);
        assert_eq!(slides[0].title, "First in deck");
        assert!(slides[0].hidden);
        assert_eq!(slides[1].title, "Second in deck");
        assert!(matches!(&slides[0].blocks[0], Block::List { level: 1, .. }));
        assert_eq!(slides[2].notes, "Speaker says hello");
        assert!(!slides[2].notes.contains("99"));
    }
    #[test]
    fn repeated_shapes_stop_at_the_materialization_budget() {
        let xml = format!(
            "<sld><sp><p><t>{}</t></p></sp><sp><p><t>{}</t></p></sp></sld>",
            "a".repeat(500),
            "b".repeat(500)
        );
        let root = super::super::xml::parse(xml.as_bytes()).unwrap();
        let mut blocks = Vec::new();
        let mut pictures = Vec::new();
        assert!(matches!(
            visit(
                &root,
                &BTreeMap::new(),
                1,
                &mut blocks,
                &mut pictures,
                &mut Budget::new(1_000)
            ),
            Err(Failure::TooLarge { .. })
        ));
        assert_eq!(blocks.len(), 1);
    }
    #[test]
    fn tables_preserve_text_and_spans_and_charts_are_named() {
        let xml = br#"<sld><tbl><tr><tc gridSpan="2" rowSpan="3"><p><t>Cell</t></p></tc></tr></tbl><chart id="c"/></sld>"#;
        let root = super::super::xml::parse(xml).unwrap();
        let rels = BTreeMap::from([(
            "c".into(),
            Relationship {
                kind: "chart".into(),
                target: "ppt/charts/chart1.xml".into(),
                external: false,
            },
        )]);
        let mut blocks = Vec::new();
        let mut pictures = Vec::new();
        visit(
            &root,
            &rels,
            1,
            &mut blocks,
            &mut pictures,
            &mut Budget::new(100_000),
        )
        .unwrap();
        assert!(
            matches!(&blocks[0],Block::Table{rows} if rows[0][0].text == "Cell" && rows[0][0].colspan == 2 && rows[0][0].rowspan == 3)
        );
        assert!(matches!(&blocks[1],Block::Chart{name} if name == "ppt/charts/chart1.xml"));
    }
    #[test]
    fn nested_table_paragraphs_are_charged_before_joining() {
        let xml = format!(
            "<tbl><tr><tc><p><p><p><t>{}</t></p></p></p></tc></tr></tbl>",
            "x".repeat(500)
        );
        let node = super::super::xml::parse(xml.as_bytes()).unwrap();
        let mut blocks = Vec::new();
        assert!(matches!(
            visit(
                &node,
                &BTreeMap::new(),
                1,
                &mut blocks,
                &mut Vec::new(),
                &mut Budget::new(1_000)
            ),
            Err(Failure::TooLarge { .. })
        ));
        assert!(blocks.is_empty());
    }
}
