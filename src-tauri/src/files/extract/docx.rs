//! Word body order, styles, numbering and relationships without executing fields.
use super::{
    materialize::Budget,
    package::{Package, Relationship},
    xml::Node,
    Block, Document, Failure, Inline, Limits, Parsed, Picture, PicturePlace, TableCell,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
struct Style {
    parent: Option<String>,
    heading: Option<u8>,
}
#[derive(Clone)]
struct Level {
    start: i64,
    format: String,
    label: String,
}
#[derive(Default)]
struct Numbering {
    levels: BTreeMap<(String, u8), Level>,
    counters: BTreeMap<(String, u8), i64>,
}
impl Numbering {
    fn read(root: Option<Node>, limit: u64) -> Result<Self, Failure> {
        let Some(root) = root else {
            return Ok(Self::default());
        };
        let mut budget = Budget::new(limit);
        let mut abstract_levels = BTreeMap::new();
        for item in root.descendants("abstractNum") {
            let Some(id) = item.attr("abstractNumId") else {
                continue;
            };
            for level in item.children.iter().filter(|n| n.name == "lvl") {
                let index = level
                    .attr("ilvl")
                    .and_then(|v| v.parse::<u8>().ok())
                    .unwrap_or(0)
                    .min(8);
                abstract_levels.insert((id.to_owned(), index), parse_level(level));
            }
        }
        let mut levels = BTreeMap::new();
        for num in root.descendants("num") {
            let (Some(id), Some(base)) = (
                num.attr("numId"),
                num.child("abstractNumId").and_then(|n| n.attr("val")),
            ) else {
                continue;
            };
            for ((abstract_id, index), level) in &abstract_levels {
                if abstract_id == base {
                    budget.charge(level.label.len() as u64 + level.format.len() as u64 + 128)?;
                    levels.insert((id.to_owned(), *index), level.clone());
                }
            }
            for over in num.children.iter().filter(|n| n.name == "lvlOverride") {
                let index = over
                    .attr("ilvl")
                    .and_then(|v| v.parse::<u8>().ok())
                    .unwrap_or(0)
                    .min(8);
                if let Some(level) = over.child("lvl") {
                    levels.insert((id.to_owned(), index), parse_level(level));
                }
                if let Some(start) = over
                    .child("startOverride")
                    .and_then(|n| n.attr("val"))
                    .and_then(|s| s.parse().ok())
                {
                    if let Some(level) = levels.get_mut(&(id.to_owned(), index)) {
                        level.start = start;
                    }
                }
            }
        }
        Ok(Self {
            levels,
            counters: BTreeMap::new(),
        })
    }
    fn label(&mut self, id: &str, index: u8, budget: &Budget) -> Result<String, Failure> {
        let key = (id.to_owned(), index);
        let Some(level) = self.levels.get(&key) else {
            return Ok("•".into());
        };
        // A level label is reused across paragraphs. Reserve for its worst
        // numeric expansion before copying or replacing any placeholders.
        budget.ensure((level.label.len() as u64).saturating_mul(20))?;
        self.counters
            .retain(|(num, depth), _| num != id || *depth <= index);
        let count = self
            .counters
            .entry(key)
            .or_insert(level.start.saturating_sub(1));
        *count = count.saturating_add(1);
        if level.format == "bullet" {
            return Ok(level.label.clone());
        }
        let mut label = level.label.clone();
        for depth in 0..=8 {
            let key = (id.to_owned(), depth);
            let n = self
                .counters
                .get(&key)
                .copied()
                .unwrap_or_else(|| self.levels.get(&key).map_or(1, |l| l.start));
            let format = self
                .levels
                .get(&key)
                .map_or("decimal", |l| l.format.as_str());
            label = label.replace(&format!("%{}", depth + 1), &number(n, format));
        }
        Ok(label)
    }
}
fn parse_level(node: &Node) -> Level {
    Level {
        start: node
            .child("start")
            .and_then(|n| n.attr("val"))
            .and_then(|s| s.parse().ok())
            .unwrap_or(1),
        format: node
            .child("numFmt")
            .and_then(|n| n.attr("val"))
            .unwrap_or("decimal")
            .into(),
        label: node
            .child("lvlText")
            .and_then(|n| n.attr("val"))
            .unwrap_or("%1.")
            .into(),
    }
}
fn number(n: i64, kind: &str) -> String {
    if (1..=26).contains(&n) && matches!(kind, "lowerLetter" | "upperLetter") {
        let base = if kind == "lowerLetter" { b'a' } else { b'A' };
        return char::from(base + (n - 1) as u8).to_string();
    }
    if (1..=3999).contains(&n) && matches!(kind, "lowerRoman" | "upperRoman") {
        let mut n = n;
        let mut out = String::new();
        for (value, text) in [
            (1000, "M"),
            (900, "CM"),
            (500, "D"),
            (400, "CD"),
            (100, "C"),
            (90, "XC"),
            (50, "L"),
            (40, "XL"),
            (10, "X"),
            (9, "IX"),
            (5, "V"),
            (4, "IV"),
            (1, "I"),
        ] {
            while n >= value {
                out.push_str(text);
                n -= value;
            }
        }
        return if kind == "lowerRoman" {
            out.to_lowercase()
        } else {
            out
        };
    }
    n.to_string()
}
fn heading_name(name: &str) -> Option<u8> {
    name.to_ascii_lowercase()
        .strip_prefix("heading")
        .and_then(|s| s.trim().parse::<u8>().ok())
        .filter(|n| (1..=9).contains(n))
}
fn outline(node: &Node) -> Option<u8> {
    node.descendants("outlineLvl")
        .next()
        .and_then(|n| n.attr("val"))
        .and_then(|s| s.parse::<u8>().ok())
        .filter(|n| *n < 9)
        .map(|n| n + 1)
}
fn styles(root: Option<Node>) -> BTreeMap<String, Style> {
    let mut out = BTreeMap::new();
    if let Some(root) = root {
        for node in root.descendants("style") {
            if let Some(id) = node.attr("styleId") {
                out.insert(
                    id.to_owned(),
                    Style {
                        parent: node
                            .child("basedOn")
                            .and_then(|n| n.attr("val"))
                            .map(str::to_owned),
                        heading: outline(node)
                            .or_else(|| {
                                node.child("name")
                                    .and_then(|n| n.attr("val"))
                                    .and_then(heading_name)
                            })
                            .or_else(|| heading_name(id)),
                    },
                );
            }
        }
    }
    out
}
fn heading(properties: Option<&Node>, styles: &BTreeMap<String, Style>) -> Option<u8> {
    let p = properties?;
    if let Some(level) = outline(p) {
        return Some(level);
    }
    let mut id = p.child("pStyle").and_then(|n| n.attr("val"))?;
    let mut seen = BTreeSet::new();
    while seen.insert(id) {
        if let Some(level) = heading_name(id) {
            return Some(level);
        }
        let style = styles.get(id)?;
        if style.heading.is_some() {
            return style.heading;
        }
        id = style.parent.as_deref()?;
    }
    None
}
pub fn safe_link(url: &str) -> bool {
    let Ok(url) = tauri::Url::parse(url) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https" | "mailto")
}
fn runs(
    node: &Node,
    rels: &BTreeMap<String, Relationship>,
    out: &mut Vec<Inline>,
    budget: &mut Budget,
) -> Result<(), Failure> {
    if matches!(
        node.name.as_str(),
        "del" | "moveFrom" | "instrText" | "fldChar" | "txbxContent" | "drawing" | "pict"
    ) {
        return Ok(());
    }
    if node.name == "hyperlink" {
        let text = visible_text(node);
        if let Some(rel) = node
            .attr("id")
            .and_then(|id| rels.get(id))
            .filter(|r| r.kind == "hyperlink" && r.external && safe_link(&r.target))
        {
            budget.charge(text.len() as u64 + rel.target.len() as u64 + 64)?;
            out.push(Inline::Link {
                text,
                url: rel.target.clone(),
            });
        } else {
            budget.charge(text.len() as u64 + 64)?;
            out.push(Inline::text(text));
        }
        return Ok(());
    }
    if node.name == "t" {
        budget.charge(node.text.len() as u64 + 64)?;
        out.push(Inline::text(&node.text));
    }
    if node.name == "tab" {
        out.push(Inline::text("\t"));
    }
    if matches!(node.name.as_str(), "br" | "cr") {
        out.push(Inline::text("\n"));
    }
    for child in &node.children {
        runs(child, rels, out, budget)?;
    }
    Ok(())
}
pub fn visible_text(node: &Node) -> String {
    if matches!(
        node.name.as_str(),
        "del" | "moveFrom" | "instrText" | "fldChar"
    ) {
        return String::new();
    }
    if node.name == "t" {
        return node.text.clone();
    }
    if node.name == "tab" {
        return "\t".into();
    }
    if matches!(node.name.as_str(), "br" | "cr") {
        return "\n".into();
    }
    node.children.iter().map(visible_text).collect()
}
fn pictures(
    node: &Node,
    rels: &BTreeMap<String, Relationship>,
    budget: &mut Budget,
) -> Result<Vec<(String, String)>, Failure> {
    let mut out = Vec::new();
    let mut pending = vec![node];
    while let Some(drawing) = pending.pop() {
        if matches!(drawing.name.as_str(), "del" | "moveFrom" | "txbxContent") {
            continue;
        }
        if drawing.name != "drawing" {
            pending.extend(drawing.children.iter().rev());
            continue;
        }
        let alt = drawing
            .descendants("docPr")
            .next()
            .and_then(|n| n.attr("descr").or_else(|| n.attr("title")))
            .unwrap_or("");
        for blip in drawing.descendants("blip") {
            if let Some(rel) = blip
                .attr("embed")
                .and_then(|id| rels.get(id))
                .filter(|r| r.kind == "image" && !r.external)
            {
                budget.charge(
                    (rel.target.len() as u64)
                        .saturating_add(alt.len() as u64)
                        .saturating_mul(2)
                        .saturating_add(256),
                )?;
                out.push((rel.target.clone(), alt.to_owned()));
            }
        }
    }
    Ok(out)
}
fn table(node: &Node) -> Block {
    let mut rows: Vec<Vec<TableCell>> = Vec::new();
    let mut anchors = BTreeMap::<usize, (usize, usize)>::new();
    for row in node.children.iter().filter(|n| n.name == "tr") {
        let mut cells = Vec::new();
        let mut column = 0;
        for cell in row.children.iter().filter(|n| n.name == "tc") {
            let props = cell.child("tcPr");
            let colspan = props
                .and_then(|p| p.child("gridSpan"))
                .and_then(|n| n.attr("val"))
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(1)
                .clamp(1, 16_384);
            let merge = props.and_then(|p| p.child("vMerge"));
            if merge.is_some_and(|n| n.attr("val") != Some("restart")) {
                if let Some(&(r, c)) = anchors.get(&column) {
                    rows[r][c].rowspan += 1;
                }
                cells.push(TableCell {
                    text: String::new(),
                    colspan,
                    rowspan: 0,
                });
            } else {
                if merge.is_some() {
                    anchors.insert(column, (rows.len(), cells.len()));
                } else {
                    anchors.remove(&column);
                }
                cells.push(TableCell {
                    text: cell
                        .children
                        .iter()
                        .filter(|n| n.name == "p")
                        .map(visible_text)
                        .collect::<Vec<_>>()
                        .join("\n"),
                    colspan,
                    rowspan: 1,
                });
            }
            column += colspan;
        }
        rows.push(cells);
    }
    Block::Table { rows }
}
struct Body<'a> {
    styles: &'a BTreeMap<String, Style>,
    numbering: Numbering,
    rels: &'a BTreeMap<String, Relationship>,
    blocks: Vec<Block>,
    pictures: Vec<Picture>,
    budget: Budget,
}
impl Body<'_> {
    fn add_pictures(&mut self, node: &Node) -> Result<(), Failure> {
        for (part, alt) in pictures(node, self.rels, &mut self.budget)? {
            self.pictures.push(Picture {
                part: part.clone(),
                alt: alt.clone(),
                place: PicturePlace::Block {
                    block: self.blocks.len() + 1,
                },
            });
            self.blocks.push(Block::Picture { alt, part });
        }
        Ok(())
    }
    fn visit(&mut self, node: &Node) -> Result<(), Failure> {
        if matches!(node.name.as_str(), "del" | "moveFrom") {
            return Ok(());
        }
        if node.name == "tbl" {
            let block = table(node);
            self.budget.block(&block)?;
            self.blocks.push(block);
            self.add_pictures(node)?;
            return Ok(());
        }
        if node.name == "p" {
            let mut text = Vec::new();
            runs(node, self.rels, &mut text, &mut self.budget)?;
            if text.iter().any(|r| match r {
                Inline::Text { text } | Inline::Link { text, .. } => !text.is_empty(),
            }) {
                let props = node.child("pPr");
                let block = if let Some(level) = heading(props, self.styles) {
                    Block::Heading { level, runs: text }
                } else if let Some(num) = props.and_then(|n| n.child("numPr")) {
                    let id = num
                        .child("numId")
                        .and_then(|n| n.attr("val"))
                        .unwrap_or("0");
                    let level = num
                        .child("ilvl")
                        .and_then(|n| n.attr("val"))
                        .and_then(|s| s.parse::<u8>().ok())
                        .unwrap_or(0)
                        .min(8);
                    Block::List {
                        level,
                        label: self.numbering.label(id, level, &self.budget)?,
                        runs: text,
                    }
                } else {
                    Block::Paragraph { runs: text }
                };
                self.budget.block(&block)?;
                self.blocks.push(block);
            }
            self.add_pictures(node)?;
            // Text boxes are excluded from the parent runs, then visited once.
            for box_node in node.descendants("txbxContent") {
                for child in &box_node.children {
                    self.visit(child)?;
                }
            }
            return Ok(());
        }
        for child in &node.children {
            self.visit(child)?;
        }
        Ok(())
    }
}
pub fn read(package: &mut Package, limits: Limits) -> Result<Parsed, Failure> {
    let part = package.office_part("word/document.xml")?;
    let rels = package.relationships(&part)?;
    let styles_part = rels
        .values()
        .find(|r| r.kind == "styles" && !r.external)
        .map(|r| r.target.as_str())
        .unwrap_or("word/styles.xml");
    let styles = styles(package.optional_xml(styles_part)?);
    let numbering_part = rels
        .values()
        .find(|r| r.kind == "numbering" && !r.external)
        .map(|r| r.target.as_str())
        .unwrap_or("word/numbering.xml");
    let numbering = Numbering::read(
        package.optional_xml(numbering_part)?,
        limits.total_parts_bytes,
    )?;
    let root = package.xml(&part)?;
    let body = root
        .child("body")
        .ok_or_else(|| Failure::corrupt("the Word document has no body"))?;
    let mut reader = Body {
        styles: &styles,
        numbering,
        rels: &rels,
        blocks: Vec::new(),
        pictures: Vec::new(),
        budget: Budget::new(limits.total_parts_bytes),
    };
    reader.visit(body)?;
    let mut not_carried = Vec::new();
    for (kind, label) in [
        ("header", "headers"),
        ("footer", "footers"),
        ("footnotes", "footnotes"),
        ("endnotes", "endnotes"),
        ("comments", "comments"),
    ] {
        if rels.values().any(|r| r.kind == kind) {
            not_carried.push(label.into());
        }
    }
    if root
        .descendants("instrText")
        .any(|n| n.text.trim_start().starts_with("TOC"))
    {
        not_carried.push("table of contents fields".into());
    }
    Ok((Document::Word(reader.blocks), reader.pictures, not_carried))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::extract::{self, testdocs, Format, Limits};
    #[test]
    fn headings_lists_tables_links_and_revisions_are_carried() {
        let doc = extract::open(testdocs::docx(), Format::Docx, Limits::SHIPPED).unwrap();
        let Document::Word(blocks) = &doc.document else {
            panic!("word");
        };
        assert!(matches!(&blocks[0], Block::Heading { level: 1, .. }));
        assert!(matches!(&blocks[1], Block::Heading { level: 3, .. }));
        assert!(matches!(&blocks[2],Block::List{label,..} if label == "4."));
        assert!(matches!(&blocks[3],Block::List{label,..} if label == "5."));
        let Block::Table { rows } = &blocks[5] else {
            panic!("table");
        };
        assert_eq!((rows[0][0].colspan, rows[0][0].rowspan), (2, 2));
        let (md, _) = extract::markdown::capture_markdown(&doc.document, Limits::SHIPPED);
        assert!(md.contains("Kept inserted [site](https://example.test/notes)"));
        assert!(!md.contains("deleted"));
        assert!(!md.contains("TOC"));
        assert_eq!(md.matches("Text box once").count(), 1);
        assert_eq!(doc.not_carried, ["headers", "table of contents fields"]);
    }
    #[test]
    fn links_accept_only_web_and_mail_schemes() {
        for url in [
            "https://example.test",
            "http://example.test",
            "mailto:person@example.test",
        ] {
            assert!(safe_link(url));
        }
        for url in [
            "javascript:alert(1)",
            "file:///tmp/x",
            "cerebro://x",
            "data:text/html,hi",
            "/relative",
        ] {
            assert!(!safe_link(url));
        }
    }
    #[test]
    fn numbering_labels_honor_letters_and_roman() {
        assert_eq!(number(4, "upperRoman"), "IV");
        assert_eq!(number(2, "lowerLetter"), "b");
    }
    #[test]
    fn strict_namespaces_and_built_in_heading_names_read_the_same() {
        let xml = br#"<w:document xmlns:w="http://purl.oclc.org/ooxml/wordprocessingml/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Strict heading</w:t></w:r></w:p></w:body></w:document>"#;
        let doc = extract::open(
            testdocs::package(&[("WORD/DOCUMENT.XML", xml)]),
            Format::Docx,
            Limits::SHIPPED,
        )
        .unwrap();
        let Document::Word(blocks) = doc.document else {
            panic!("word");
        };
        assert!(matches!(&blocks[0], Block::Heading { level: 2, .. }));
    }
    #[test]
    fn reused_numbering_and_link_metadata_stays_inside_the_budget() {
        let numbering = format!("<numbering><abstractNum abstractNumId=\"1\"><lvl ilvl=\"0\"><lvlText val=\"{}\"/></lvl></abstractNum>{}</numbering>","x".repeat(500),(1..=10).map(|id|format!("<num numId=\"{id}\"><abstractNumId val=\"1\"/></num>")).collect::<String>());
        let root = super::super::xml::parse(numbering.as_bytes()).unwrap();
        assert!(matches!(
            Numbering::read(Some(root), 2_000),
            Err(Failure::TooLarge { .. })
        ));
        let paragraph = super::super::xml::parse(br#"<p><hyperlink id="r"><t>A</t></hyperlink><hyperlink id="r"><t>B</t></hyperlink></p>"#).unwrap();
        let rels = BTreeMap::from([(
            "r".into(),
            Relationship {
                kind: "hyperlink".into(),
                target: format!("https://example.test/{}", "a".repeat(500)),
                external: true,
            },
        )]);
        let mut out = Vec::new();
        let mut budget = Budget::new(900);
        assert!(matches!(
            runs(&paragraph, &rels, &mut out, &mut budget),
            Err(Failure::TooLarge { .. })
        ));
        assert_eq!(out.len(), 1);
    }
    #[test]
    fn repeated_picture_alt_text_is_charged_before_it_is_copied() {
        let xml = format!(
            "<p><drawing><docPr descr=\"{}\"/><blip embed=\"r\"/><blip embed=\"r\"/></drawing></p>",
            "a".repeat(500)
        );
        let node = super::super::xml::parse(xml.as_bytes()).unwrap();
        let rels = BTreeMap::from([(
            "r".into(),
            Relationship {
                kind: "image".into(),
                target: "word/media/pic.png".into(),
                external: false,
            },
        )]);
        assert!(matches!(
            pictures(&node, &rels, &mut Budget::new(2_000)),
            Err(Failure::TooLarge { .. })
        ));
    }
    #[test]
    fn pictures_inside_table_cells_keep_their_part_and_place() {
        let xml = br#"<document><body><tbl><tr><tc><p><r><t>Cell</t><drawing><docPr descr="Cell picture"/><blip embed="pic"/></drawing></r></p></tc></tr></tbl></body></document>"#;
        let rels = testdocs::relationships(&[("pic", "image", "media/cell.png")]);
        let doc = extract::open(
            testdocs::package(&[
                ("word/document.xml", xml),
                ("word/_rels/document.xml.rels", rels.as_bytes()),
            ]),
            Format::Docx,
            Limits::SHIPPED,
        )
        .unwrap();
        assert_eq!(doc.pictures.len(), 1);
        assert_eq!(doc.pictures[0].part, "word/media/cell.png");
        assert_eq!(doc.pictures[0].alt, "Cell picture");
        assert!(matches!(
            doc.pictures[0].place,
            PicturePlace::Block { block: 2 }
        ));
        let Document::Word(blocks) = doc.document else {
            panic!("word");
        };
        assert!(matches!(&blocks[0], Block::Table { rows } if rows[0][0].text == "Cell"));
        assert!(matches!(&blocks[1], Block::Picture { .. }));
    }
}
