//! Documents are generated from text in each test; no opaque Office fixture.
pub struct TempDir(std::path::PathBuf);
impl TempDir {
    pub fn new() -> Self {
        Self(crate::vault::testutil::temp_vault("extract"))
    }
    pub fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
pub fn package(parts: &[(&str, &[u8])]) -> Vec<u8> {
    super::package::test_package(parts)
}
pub fn relationships(rows: &[(&str, &str, &str)]) -> String {
    format!("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{}</Relationships>",rows.iter().map(|(id,kind,target)|format!("<Relationship Id=\"{id}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}\" Target=\"{target}\"/>")).collect::<String>())
}
pub const PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 16, 9, 168, 248, 15, 0, 3,
    52, 1, 220, 241, 40, 158, 74, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
pub fn docx() -> Vec<u8> {
    let root_rels = relationships(&[("r1", "officeDocument", "word/document.xml")]);
    let rels = relationships(&[("image1","image","media/picture.png"),("head","header","header.xml")]).replace("</Relationships>","<Relationship Id=\"web\" Type=\"http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink\" Target=\"https://example.test/notes\" TargetMode=\"External\"/></Relationships>");
    package(&[
        ("_rels/.rels",root_rels.as_bytes()),
        ("word/_rels/document.xml.rels",rels.as_bytes()),
        ("word/document.xml",br#"<w:document xmlns:w="urn:word" xmlns:r="urn:relationships" xmlns:a="urn:draw" xmlns:wp="urn:wp"><w:body>
<w:p><w:pPr><w:pStyle w:val="Child"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>
<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>Details</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr></w:pPr><w:r><w:t>First</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="9"/></w:numPr></w:pPr><w:r><w:t>Second</w:t></w:r></w:p>
<w:p><w:r><w:t>Kept </w:t></w:r><w:del><w:r><w:t>deleted</w:t></w:r></w:del><w:ins><w:r><w:t>inserted </w:t></w:r></w:ins><w:r><w:instrText>TOC</w:instrText></w:r><w:hyperlink r:id="web"><w:r><w:t>site</w:t></w:r></w:hyperlink></w:p>
<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>Merged</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>
<w:p><w:r><w:drawing><wp:docPr descr="A dot"/><a:blip r:embed="image1"/></w:drawing></w:r></w:p>
<w:p><w:r><w:pict><w:txbxContent><w:p><w:r><w:t>Text box once</w:t></w:r></w:p></w:txbxContent></w:pict></w:r></w:p>
</w:body></w:document>"#),
        ("word/styles.xml",br#"<w:styles xmlns:w="urn:word"><w:style w:styleId="Parent"><w:name w:val="Heading 1"/></w:style><w:style w:styleId="Child"><w:basedOn w:val="Parent"/></w:style></w:styles>"#),
        ("word/numbering.xml",br#"<w:numbering xmlns:w="urn:word"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="9"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/></w:lvlOverride></w:num></w:numbering>"#),
        ("word/media/picture.png",PNG),
    ])
}
pub fn pptx() -> Vec<u8> {
    let root_rels = relationships(&[("r1", "officeDocument", "ppt/presentation.xml")]);
    let rels = relationships(&[
        ("s1", "slide", "slides/slide1.xml"),
        ("s2", "slide", "slides/slide2.xml"),
        ("s3", "slide", "slides/slide3.xml"),
    ]);
    let slide_rels = relationships(&[
        ("notes", "notesSlide", "../notesSlides/notesSlide1.xml"),
        ("img", "image", "../media/image.png"),
    ]);
    package(&[
        ("_rels/.rels",root_rels.as_bytes()),("ppt/_rels/presentation.xml.rels",rels.as_bytes()),
        ("ppt/presentation.xml",br#"<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="258" r:id="s2"/><p:sldId r:id="s1" id="257"/><p:sldId id="259" r:id="s3"/></p:sldIdLst></p:presentation>"#),
        ("ppt/slides/slide1.xml",br#"<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Second in deck</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#),
        ("ppt/slides/slide2.xml",br#"<p:sld xmlns:p="urn:p" xmlns:a="urn:a" xmlns:r="urn:r" show="0"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>First in deck</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:txBody><a:p><a:pPr lvl="1"><a:buChar char="-"/></a:pPr><a:r><a:t>Indented bullet</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr descr="Dot on slide"/></p:nvPicPr><p:blipFill><a:blip r:embed="img"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>"#),
        ("ppt/slides/slide3.xml",br#"<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Third slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#),
        ("ppt/slides/_rels/slide2.xml.rels",slide_rels.as_bytes()),("ppt/slides/_rels/slide3.xml.rels",slide_rels.as_bytes()),
        ("ppt/notesSlides/notesSlide1.xml",br#"<p:notes xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Speaker says hello</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>99</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>"#),
        ("ppt/media/image.png",PNG),
    ])
}
pub fn xlsx_cells(cells: &str, extra: &str) -> Vec<u8> {
    xlsx_shared(cells, extra, "<sst xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" uniqueCount=\"0\"></sst>")
}
pub fn xlsx_shared(cells: &str, extra: &str, shared: &str) -> Vec<u8> {
    let root_rels = relationships(&[("r1", "officeDocument", "xl/workbook.xml")]);
    let rels = relationships(&[
        ("s1", "worksheet", "worksheets/sheet1.xml"),
        ("style", "styles", "styles.xml"),
    ]);
    let sheet_rels = relationships(&[("draw", "drawing", "../drawings/drawing1.xml")]);
    let drawing_rels = relationships(&[("image", "image", "../media/image.png")]);
    let sheet = format!("<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>{cells}</sheetData>{extra}</worksheet>");
    package(&[
        ("_rels/.rels",root_rels.as_bytes()),("xl/_rels/workbook.xml.rels",rels.as_bytes()),
        ("xl/workbook.xml",br#"<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Results" sheetId="1" state="hidden" r:id="s1"/></sheets></workbook>"#),
        ("xl/styles.xml",br#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>"#),
        ("xl/worksheets/sheet1.xml",sheet.as_bytes()),("xl/worksheets/_rels/sheet1.xml.rels",sheet_rels.as_bytes()),
        ("xl/drawings/drawing1.xml",br#"<xdr:wsDr xmlns:xdr="urn:d" xmlns:a="urn:a" xmlns:r="urn:r"><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>2</xdr:row></xdr:from><xdr:pic><xdr:nvPicPr><xdr:cNvPr descr="Workbook dot"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="image"/></xdr:blipFill></xdr:pic></xdr:twoCellAnchor></xdr:wsDr>"#),
        ("xl/drawings/_rels/drawing1.xml.rels",drawing_rels.as_bytes()),("xl/media/image.png",PNG),
        ("xl/sharedStrings.xml",shared.as_bytes()),
    ])
}
pub fn xlsx() -> Vec<u8> {
    xlsx_cells(
        r#"<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="n"><v>4</v></c><c r="C1" t="b"><v>1</v></c></row><row r="2"><c r="A2" s="1"><v>45292</v></c><c r="B2"><f>B1*2</f><v>8</v></c></row>"#,
        r#"<mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells>"#,
    )
}
