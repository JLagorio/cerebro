//! The only archive-opening boundary. Counts are checked before ZipArchive;
//! every inflated part is bounded independently and against the package total.
use super::{xml, Failure, Limits};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
    sync::Arc,
};
use zip::{CompressionMethod, ZipArchive};

pub struct Package {
    archive: ZipArchive<Cursor<Arc<[u8]>>>,
    source: Arc<[u8]>,
    names: BTreeMap<String, usize>,
    limits: Limits,
    total: u64,
    counted: BTreeSet<usize>,
    read_work: u64,
}
#[derive(Clone, Debug)]
pub struct Relationship {
    pub kind: String,
    pub target: String,
    pub external: bool,
}

fn u16_at(bytes: &[u8], at: usize) -> Result<u16, Failure> {
    Ok(u16::from_le_bytes(
        bytes
            .get(at..at + 2)
            .ok_or_else(|| Failure::corrupt("the ZIP directory is incomplete"))?
            .try_into()
            .expect("two bytes"),
    ))
}
fn u64_at(bytes: &[u8], at: usize) -> Result<u64, Failure> {
    Ok(u64::from_le_bytes(
        bytes
            .get(at..at + 8)
            .ok_or_else(|| Failure::corrupt("the ZIP64 directory is incomplete"))?
            .try_into()
            .expect("eight bytes"),
    ))
}
fn entry_count(bytes: &[u8]) -> Result<u64, Failure> {
    let start = bytes.len().saturating_sub(65_557);
    let at = (start..bytes.len().saturating_sub(21))
        .rev()
        .find(|&i| {
            bytes.get(i..i + 4) == Some(b"PK\x05\x06")
                && u16_at(bytes, i + 20).is_ok_and(|n| i + 22 + usize::from(n) == bytes.len())
        })
        .ok_or_else(|| Failure::corrupt("the ZIP directory is missing"))?;
    if u16_at(bytes, at + 4)? != 0 || u16_at(bytes, at + 6)? != 0 {
        return Err(Failure::corrupt("split ZIP packages are not supported"));
    }
    let count = u16_at(bytes, at + 10)?;
    if count != u16::MAX {
        let offset = u32::from_le_bytes(
            bytes
                .get(at + 16..at + 20)
                .ok_or_else(|| Failure::corrupt("the ZIP directory is incomplete"))?
                .try_into()
                .expect("four bytes"),
        ) as usize;
        return count_directory(bytes, offset, at, u64::from(count));
    }
    let locator = at
        .checked_sub(20)
        .ok_or_else(|| Failure::corrupt("the ZIP64 locator is missing"))?;
    if bytes.get(locator..locator + 4) != Some(b"PK\x06\x07") {
        return Err(Failure::corrupt("the ZIP64 locator is missing"));
    }
    let offset = usize::try_from(u64_at(bytes, locator + 8)?)
        .map_err(|_| Failure::corrupt("the ZIP64 offset is invalid"))?;
    if bytes.get(offset..offset.saturating_add(4)) != Some(b"PK\x06\x06") {
        return Err(Failure::corrupt("the ZIP64 directory is missing"));
    }
    let count = u64_at(
        bytes,
        offset
            .checked_add(32)
            .ok_or_else(|| Failure::corrupt("the ZIP64 offset is invalid"))?,
    )?;
    let directory = usize::try_from(u64_at(
        bytes,
        offset
            .checked_add(48)
            .ok_or_else(|| Failure::corrupt("the ZIP64 offset is invalid"))?,
    )?)
    .map_err(|_| Failure::corrupt("the ZIP64 offset is invalid"))?;
    count_directory(bytes, directory, offset, count)
}
fn count_directory(bytes: &[u8], mut at: usize, end: usize, declared: u64) -> Result<u64, Failure> {
    let mut count = 0_u64;
    while at < end {
        if bytes.get(at..at.saturating_add(4)) != Some(b"PK\x01\x02") {
            return Err(Failure::corrupt("the ZIP directory is malformed"));
        }
        let size = 46_usize
            + usize::from(u16_at(bytes, at + 28)?)
            + usize::from(u16_at(bytes, at + 30)?)
            + usize::from(u16_at(bytes, at + 32)?);
        at = at
            .checked_add(size)
            .ok_or_else(|| Failure::corrupt("the ZIP directory is too large"))?;
        count += 1;
    }
    if at != end || count != declared {
        return Err(Failure::corrupt(
            "the ZIP entry count disagrees with its directory",
        ));
    }
    Ok(count)
}
fn sniff(bytes: &[u8], ext: &str) -> Result<(), Failure> {
    if bytes.starts_with(b"PK") {
        return Ok(());
    }
    if bytes.starts_with(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") {
        let encrypted: Vec<u8> = "EncryptedPackage"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        return Err(if bytes.windows(encrypted.len()).any(|s| s == encrypted) {
            Failure::Encrypted
        } else {
            Failure::unsupported("an older binary Office file (.doc, .ppt or .xls) under a newer name; Cerebro reads only the newer format")
        });
    }
    Err(Failure::corrupt(if bytes.starts_with(b"%PDF") {
        format!("a PDF under a .{ext} name")
    } else {
        "not an Office package".into()
    }))
}
impl Package {
    pub fn new(bytes: Vec<u8>, ext: &str, limits: Limits) -> Result<Self, Failure> {
        if bytes.len() as u64 > limits.file_bytes {
            return Err(Failure::too_large("the file exceeds 256 MiB"));
        }
        sniff(&bytes, ext)?;
        if entry_count(&bytes)? > limits.zip_entries as u64 {
            return Err(Failure::too_large("the package has too many entries"));
        }
        let source: Arc<[u8]> = bytes.into();
        let mut archive = ZipArchive::new(Cursor::new(source.clone()))
            .map_err(|_| Failure::corrupt("the ZIP directory could not be read"))?;
        if archive.len() > limits.zip_entries {
            return Err(Failure::too_large("the package has too many entries"));
        }
        let mut names = BTreeMap::new();
        for i in 0..archive.len() {
            let file = archive
                .by_index_raw(i)
                .map_err(|_| Failure::corrupt("a package entry could not be read"))?;
            if file.encrypted() {
                return Err(Failure::Encrypted);
            }
            if !matches!(
                file.compression(),
                CompressionMethod::Stored | CompressionMethod::Deflated
            ) {
                return Err(Failure::corrupt(
                    "the package uses a compression Office never writes",
                ));
            }
            if file.is_dir() {
                continue;
            }
            let name = normalize_part(file.name())
                .ok_or_else(|| Failure::corrupt("a package part has an invalid name"))?;
            if names.insert(name.to_ascii_lowercase(), i).is_some() {
                return Err(Failure::corrupt("the package has duplicate part names"));
            }
        }
        Ok(Self {
            archive,
            source,
            names,
            limits,
            total: 0,
            counted: BTreeSet::new(),
            read_work: 0,
        })
    }
    pub fn contains(&self, part: &str) -> bool {
        self.names.contains_key(&part.to_ascii_lowercase())
    }
    pub fn names(&self) -> Vec<String> {
        self.names.keys().cloned().collect()
    }
    pub fn read_part(&mut self, part: &str, cap: u64) -> Result<Vec<u8>, Failure> {
        let index = *self
            .names
            .get(&part.to_ascii_lowercase())
            .ok_or_else(|| Failure::corrupt(format!("the package is missing {part}")))?;
        let remaining = if self.counted.contains(&index) {
            self.limits.part_bytes
        } else {
            self.limits.total_parts_bytes.saturating_sub(self.total)
        };
        // Verification, format parsing, and selected-image reads may revisit
        // parts. Bound repeated inflation too, not just unique retained bytes.
        let work_left = self
            .limits
            .total_parts_bytes
            .saturating_mul(4)
            .saturating_sub(self.read_work);
        let cap = cap
            .min(self.limits.part_bytes)
            .min(remaining)
            .min(work_left);
        let file = self
            .archive
            .by_index(index)
            .map_err(|_| Failure::corrupt("a package part could not be opened"))?;
        if file.size() > cap {
            return Err(Failure::too_large(
                "a package part or the total unpacked size exceeds its limit",
            ));
        }
        let mut bytes = Vec::new();
        file.take(cap.saturating_add(1))
            .read_to_end(&mut bytes)
            .map_err(|_| Failure::corrupt("a package part is damaged"))?;
        if bytes.len() as u64 > cap {
            return Err(Failure::too_large(
                "a package part or the total unpacked size exceeds its limit",
            ));
        }
        if self.counted.insert(index) {
            self.total += bytes.len() as u64;
        }
        self.read_work += bytes.len() as u64;
        Ok(bytes)
    }
    pub fn xml(&mut self, part: &str) -> Result<xml::Node, Failure> {
        let bytes = self.read_part(part, self.limits.part_bytes)?;
        xml::parse(&bytes)
    }
    pub fn optional_xml(&mut self, part: &str) -> Result<Option<xml::Node>, Failure> {
        if self.contains(part) {
            self.xml(part).map(Some)
        } else {
            Ok(None)
        }
    }
    /// Verify every part before a library that opens its own internal readers.
    /// Re-reading a verified part does not count its unpacked bytes twice, but
    /// still applies the caller's cap and the part cap on every read.
    pub fn verify_all(&mut self) -> Result<(), Failure> {
        for name in self.names() {
            let bytes = self.read_part(&name, self.limits.part_bytes)?;
            if name.ends_with(".xml") || name.ends_with(".rels") {
                xml::parse(&bytes)?;
            }
        }
        Ok(())
    }
    pub fn bytes(&self) -> &[u8] {
        &self.source
    }
    pub fn relationships(
        &mut self,
        source: &str,
    ) -> Result<BTreeMap<String, Relationship>, Failure> {
        let (folder, file) = source.rsplit_once('/').unwrap_or(("", source));
        let path = if source.is_empty() {
            "_rels/.rels".to_owned()
        } else if folder.is_empty() {
            format!("_rels/{file}.rels")
        } else {
            format!("{folder}/_rels/{file}.rels")
        };
        let Some(root) = self.optional_xml(&path)? else {
            return Ok(BTreeMap::new());
        };
        let mut out = BTreeMap::new();
        for rel in root.descendants("Relationship") {
            let (Some(id), Some(kind), Some(target)) =
                (rel.attr("Id"), rel.attr("Type"), rel.attr("Target"))
            else {
                return Err(Failure::corrupt("a package relationship is incomplete"));
            };
            let external = rel
                .attr("TargetMode")
                .is_some_and(|v| v.eq_ignore_ascii_case("external"));
            let target = if external {
                target.to_owned()
            } else {
                resolve_part(source, target)
                    .ok_or_else(|| Failure::corrupt("a relationship escapes the package"))?
            };
            if out
                .insert(
                    id.to_owned(),
                    Relationship {
                        kind: kind.rsplit('/').next().unwrap_or(kind).to_owned(),
                        target,
                        external,
                    },
                )
                .is_some()
            {
                return Err(Failure::corrupt("duplicate relationship id"));
            }
        }
        Ok(out)
    }
    pub fn office_part(&mut self, fallback: &str) -> Result<String, Failure> {
        Ok(self
            .relationships("")?
            .values()
            .find(|r| r.kind == "officeDocument" && !r.external)
            .map(|r| r.target.clone())
            .unwrap_or_else(|| fallback.into()))
    }
}

/// A single derived preview still crosses the same pre-allocation directory
/// check and actual-inflation cap as Office parts. No archive opens elsewhere.
pub fn read_entry(bytes: Vec<u8>, name: &str, cap: u64) -> Result<Option<Vec<u8>>, Failure> {
    let mut package = Package::new(bytes, "fig", Limits::SHIPPED)?;
    if !package.contains(name) {
        return Ok(None);
    }
    package.read_part(name, cap).map(Some)
}

#[cfg(test)]
pub(crate) fn test_package(parts: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in parts {
        zip.start_file(
            *name,
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
pub fn normalize_part(part: &str) -> Option<String> {
    if part.is_empty() || part.contains('\\') || part.contains('\0') {
        return None;
    }
    let part = part.trim_start_matches('/');
    if part
        .split('/')
        .any(|s| s.is_empty() || s == "." || s == "..")
    {
        return None;
    }
    Some(part.to_owned())
}
pub fn resolve_part(source: &str, target: &str) -> Option<String> {
    let target = percent_encoding::percent_decode_str(target)
        .decode_utf8()
        .ok()?;
    let target = target.as_ref();
    if target.contains(['\\', '\0', '?', '#']) {
        return None;
    }
    let mut parts: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        source
            .rsplit_once('/')
            .map(|(p, _)| p.split('/').collect())
            .unwrap_or_default()
    };
    for part in target.trim_start_matches('/').split('/') {
        match part {
            "." | "" => {}
            ".." => {
                parts.pop()?;
            }
            _ => parts.push(part),
        }
    }
    normalize_part(&parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::extract::testdocs;
    fn package(parts: &[(&str, &[u8])], limits: Limits) -> Package {
        Package::new(testdocs::package(parts), "docx", limits).unwrap()
    }
    #[test]
    fn a_file_over_its_cap_is_too_large_before_any_parse() {
        assert!(matches!(
            Package::new(
                vec![0; 20],
                "docx",
                Limits {
                    file_bytes: 10,
                    ..Limits::SHIPPED
                }
            ),
            Err(Failure::TooLarge { .. })
        ));
    }
    #[test]
    fn too_many_entries_is_too_large() {
        let bytes = testdocs::package(&[("a", b"a"), ("b", b"b")]);
        assert!(matches!(
            Package::new(
                bytes,
                "docx",
                Limits {
                    zip_entries: 1,
                    ..Limits::SHIPPED
                }
            ),
            Err(Failure::TooLarge { .. })
        ));
    }
    #[test]
    fn zip64_counts_are_checked_before_the_archive_opens() {
        let mut bytes = testdocs::package(&[("a", b"a")]);
        let eocd = bytes.windows(4).position(|s| s == b"PK\x05\x06").unwrap();
        let old = bytes[eocd..].to_vec();
        bytes.truncate(eocd);
        let directory = u32::from_le_bytes(old[16..20].try_into().unwrap()) as u64;
        let directory_size = u32::from_le_bytes(old[12..16].try_into().unwrap()) as u64;
        bytes.extend(b"PK\x06\x06");
        bytes.extend(44_u64.to_le_bytes());
        bytes.extend([45, 0, 45, 0]);
        bytes.extend([0; 8]);
        bytes.extend(1_u64.to_le_bytes());
        bytes.extend(1_u64.to_le_bytes());
        bytes.extend(directory_size.to_le_bytes());
        bytes.extend(directory.to_le_bytes());
        bytes.extend(b"PK\x06\x07");
        bytes.extend([0; 4]);
        bytes.extend((eocd as u64).to_le_bytes());
        bytes.extend(1_u32.to_le_bytes());
        let mut old = old;
        old[8..12].fill(255);
        bytes.extend(old);
        assert_eq!(entry_count(&bytes).unwrap(), 1);
        assert!(matches!(
            Package::new(
                bytes,
                "docx",
                Limits {
                    zip_entries: 0,
                    ..Limits::SHIPPED
                }
            ),
            Err(Failure::TooLarge { .. })
        ));
    }
    #[test]
    fn a_part_past_its_cap_is_too_large_however_its_header_lies() {
        let mut bytes = testdocs::package(&[("a", &[b'a'; 1024])]);
        let central = bytes.windows(4).position(|s| s == b"PK\x01\x02").unwrap();
        bytes[central + 24..central + 28].copy_from_slice(&1_u32.to_le_bytes());
        bytes[22..26].copy_from_slice(&1_u32.to_le_bytes());
        let mut p = Package::new(bytes, "docx", Limits::SHIPPED).unwrap();
        assert!(matches!(
            p.read_part("a", 10),
            Err(Failure::TooLarge { .. })
        ));
    }
    #[test]
    fn parts_together_cannot_pass_the_total() {
        let mut p = package(
            &[("a", b"1234"), ("b", b"5678")],
            Limits {
                total_parts_bytes: 7,
                ..Limits::SHIPPED
            },
        );
        assert_eq!(p.read_part("a", 100).unwrap(), b"1234");
        assert!(matches!(
            p.read_part("b", 100),
            Err(Failure::TooLarge { .. })
        ));
    }
    #[test]
    fn an_encrypted_package_is_encrypted() {
        let mut ole = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1".to_vec();
        ole.extend("EncryptedPackage".encode_utf16().flat_map(u16::to_le_bytes));
        assert!(matches!(
            Package::new(ole, "docx", Limits::SHIPPED),
            Err(Failure::Encrypted)
        ));
    }
    #[test]
    fn an_older_binary_office_file_is_unsupported() {
        assert!(matches!(
            Package::new(
                b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1".to_vec(),
                "docx",
                Limits::SHIPPED
            ),
            Err(Failure::Unsupported { .. })
        ));
    }
    #[test]
    fn a_pdf_under_an_office_name_is_corrupt_and_says_so() {
        match Package::new(b"%PDF-1.7".to_vec(), "docx", Limits::SHIPPED) {
            Err(Failure::Corrupt { detail }) => assert_eq!(detail, "a PDF under a .docx name"),
            _ => panic!("expected corrupt PDF"),
        }
    }
    #[test]
    fn a_compression_office_never_writes_is_corrupt() {
        let mut bytes = testdocs::package(&[("a", b"a")]);
        let central = bytes.windows(4).position(|s| s == b"PK\x01\x02").unwrap();
        bytes[central + 10..central + 12].copy_from_slice(&12_u16.to_le_bytes());
        assert!(matches!(
            Package::new(bytes, "docx", Limits::SHIPPED),
            Err(Failure::Corrupt { .. })
        ));
    }
    #[test]
    fn relationships_resolve_relative_absolute_and_strict_types() {
        let rels = br#"<Relationships><Relationship Id="a" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/image" Target="../media/pic.png"/><Relationship Id="b" Type="urn/notesSlide" Target="/notes/x.xml"/></Relationships>"#;
        let mut p = package(
            &[("PPT/SLIDES/_RELS/SLIDE1.XML.RELS", rels)],
            Limits::SHIPPED,
        );
        let r = p.relationships("ppt/slides/slide1.xml").unwrap();
        assert_eq!(r["a"].target, "ppt/media/pic.png");
        assert_eq!(r["a"].kind, "image");
        assert_eq!(r["b"].target, "notes/x.xml");
        assert_eq!(resolve_part("word/document.xml", "../../outside"), None);
        assert_eq!(
            resolve_part("word/document.xml", "media/image%201.png"),
            Some("word/media/image 1.png".into())
        );
    }
    #[test]
    fn read_part_stops_at_its_cap() {
        let mut p = package(&[("a", b"12345")], Limits::SHIPPED);
        assert!(matches!(p.read_part("A", 4), Err(Failure::TooLarge { .. })));
        assert_eq!(p.read_part("a", 5).unwrap(), b"12345");
    }
}
