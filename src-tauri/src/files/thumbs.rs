//! Purgeable, bounded previews. Every input read uses the contained descriptor;
//! Quick Look sees a private copy, never a replaceable path in the vault.
use super::{
    bytes::{self, OpenedFile},
    extract::{self, package},
    images, kinds,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, Metadata, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::{Condvar, Mutex},
    time::UNIX_EPOCH,
};

const INPUT_CAP: u64 = 64 * 1024 * 1024;
const PREVIEW_CAP: u64 = 8 * 1024 * 1024;
const OUTPUT_CAP: u64 = 512 * 1024;
const CACHE_CAP: u64 = 256 * 1024 * 1024;
const QUICK_EXTS: &[&str] = &[
    "pdf", "docx", "pptx", "xlsx", "xlsm", "doc", "ppt", "xls", "key", "pages", "numbers", "heic",
    "heif", "avif", "tif", "tiff", "svg", "mov", "mp4", "m4v",
];

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Reason {
    TooLarge,
    Unsupported,
    Corrupt,
    NoPreview,
    NotFound,
    ToolMissing,
    TimedOut,
}
impl Reason {
    fn cached(self) -> bool {
        matches!(
            self,
            Self::TooLarge | Self::Unsupported | Self::Corrupt | Self::NoPreview
        )
    }
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Image,
    Fig,
    Psd,
    QuickLook,
}
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Thumbnail {
    Ready {
        #[serde(rename = "dataUrl")]
        data_url: String,
        width: u32,
        height: u32,
        source: Source,
    },
    None {
        reason: Reason,
    },
}
#[derive(Debug)]
struct Preview {
    picture: images::Prepared,
    source: Source,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::extract::testdocs::{self, TempDir, PNG};
    use std::cell::Cell;
    struct Fake { calls: Cell<usize>, answer: Result<Vec<u8>, Reason> }
    impl QuickLook for Fake {
        fn run(&self, _bytes: &[u8], _ext: &str, _size: u32, _cache: &Path) -> Result<Vec<u8>, Reason> {
            self.calls.set(self.calls.get()+1); self.answer.clone()
        }
    }
    fn fake(answer: Result<Vec<u8>, Reason>) -> Fake { Fake { calls: Cell::new(0), answer } }
    fn read_at(root: &Path, cache: &Path, path: &str, ql: &dyn QuickLook) -> Result<Preview, Reason> {
        read(bytes::open_in(root, "0", path).map_err(|_| Reason::NotFound)?, cache, 128, ql)
    }
    #[test]
    fn replays_thumbnail_cases() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/thumbnail-cases.json")).unwrap();
        for case in cases["sizes"].as_array().unwrap() { assert_eq!(u64::from(snap(case["input"].as_u64().unwrap() as u32)), case["expected"].as_u64().unwrap()); }
        for reason in cases["reasons"].as_array().unwrap() {
            let decoded: Reason = serde_json::from_value(reason.clone()).unwrap();
            assert_eq!(decoded.cached(), cases["cached"].as_array().unwrap().contains(reason));
            assert_eq!(serde_json::to_value(decoded).unwrap(), *reason);
        }
        for source in cases["sources"].as_array().unwrap() { let parsed: Source = serde_json::from_value(source.clone()).unwrap(); assert_eq!(serde_json::to_value(parsed).unwrap(), *source); }
    }
    #[test]
    fn a_truncated_image_is_cached_as_corrupt_and_not_retried() {
        let root = TempDir::new(); let cache = TempDir::new();
        fs::write(root.path().join("bad.png"), &PNG[..40]).unwrap();
        let ql = fake(Ok(PNG.to_vec()));
        assert_eq!(read_at(root.path(), cache.path(), "bad.png", &ql).unwrap_err(), Reason::Corrupt);
        let opened = bytes::open_in(root.path(), "0", "bad.png").unwrap();
        let hash = key(&opened, &opened.file.metadata().unwrap(), 128).unwrap();
        assert_eq!(cached(&cache.path().join("thumbs/v1"), &hash).unwrap().unwrap_err(), Reason::Corrupt);
        assert_eq!(read_at(root.path(), cache.path(), "bad.png", &ql).unwrap_err(), Reason::Corrupt);
        assert_eq!(ql.calls.get(), 0);
    }
    #[test]
    fn a_changed_file_misses_the_cache() {
        let root = TempDir::new(); let cache = TempDir::new(); let ql = fake(Ok(PNG.to_vec()));
        fs::write(root.path().join("a.png"), &PNG[..40]).unwrap();
        assert_eq!(read_at(root.path(), cache.path(), "a.png", &ql).unwrap_err(), Reason::Corrupt);
        fs::write(root.path().join("a.png"), PNG).unwrap();
        assert_eq!(read_at(root.path(), cache.path(), "a.png", &ql).unwrap().picture.width, 1);
    }
    #[test]
    fn a_fig_zip_preview_is_read_within_its_cap() {
        let ql = fake(Err(Reason::NoPreview)); let cache = TempDir::new();
        let preview = build(&testdocs::package(&[("thumbnail.png", PNG)]), "design.fig", 128, false, &ql, cache.path()).unwrap();
        assert_eq!(preview.source, Source::Fig); assert_eq!((preview.picture.width, preview.picture.height), (1,1));
    }
    #[test]
    fn a_fig_entry_over_the_cap_is_too_large() {
        let ql = fake(Err(Reason::NoPreview)); let cache = TempDir::new();
        let bytes = testdocs::package(&[("thumbnail.png", &vec![0; PREVIEW_CAP as usize + 1])]);
        assert_eq!(build(&bytes, "a.fig", 128, false, &ql, cache.path()).unwrap_err(), Reason::TooLarge);
    }
    #[test]
    fn a_legacy_fig_reads_its_third_chunk() {
        let mut bytes = b"fig-kiwi\x01\0\0\0".to_vec();
        for chunk in [b"schema".as_slice(), b"data".as_slice(), PNG] { bytes.extend((chunk.len() as u32).to_le_bytes()); bytes.extend(chunk); }
        assert_eq!(legacy_fig(&bytes).unwrap(), Some(PNG));
        bytes.pop(); assert_eq!(legacy_fig(&bytes), Err(Reason::Corrupt));
    }
    fn psd(id: u16, jpeg: &[u8]) -> Vec<u8> {
        let mut data = Vec::new();
        for value in [1_u32, 1, 1, 4, 4, jpeg.len() as u32] { data.extend(value.to_be_bytes()); }
        data.extend([0,24,0,1]); data.extend(jpeg);
        let mut resource = b"8BIM".to_vec(); resource.extend(id.to_be_bytes()); resource.extend([0,0]); resource.extend((data.len() as u32).to_be_bytes()); resource.extend(&data); if data.len()%2 == 1 { resource.push(0); }
        let mut bytes = b"8BPS\0\x01".to_vec(); bytes.resize(26,0); bytes.extend(0_u32.to_be_bytes()); bytes.extend((resource.len() as u32).to_be_bytes()); bytes.extend(resource); bytes
    }
    #[test]
    fn a_psd_1036_preview_is_read() {
        let jpg = images::thumbnail(PNG,128,true).unwrap().bytes;
        let bytes = psd(1036,&jpg); assert_eq!(psd_preview(&bytes).unwrap(), Some((jpg.as_slice(),false)));
        assert_eq!(build(&bytes,"a.psd",128,false,&fake(Err(Reason::NoPreview)),Path::new("unused")).unwrap().source,Source::Psd);
    }
    #[test]
    fn a_psd_1033_preview_swaps_red_and_blue() {
        let jpg = images::thumbnail(PNG,128,true).unwrap().bytes;
        let old = psd(1033,&jpg); assert_eq!(psd_preview(&old).unwrap(),Some((jpg.as_slice(),true)));
        let old = build(&old,"a.psd",128,false,&fake(Err(Reason::NoPreview)),Path::new("unused")).unwrap();
        let new = build(&psd(1036,&jpg),"a.psd",128,false,&fake(Err(Reason::NoPreview)),Path::new("unused")).unwrap();
        assert_ne!(old.picture.bytes, new.picture.bytes);
    }
    #[test]
    fn a_psd_with_a_lying_length_is_corrupt_not_a_panic() {
        let mut bytes = psd(1036,&[255,216,255]); bytes[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(psd_preview(&bytes),Err(Reason::Corrupt));
        for end in 0..bytes.len() { assert!(psd_preview(&bytes[..end]).is_err()); }
    }
    #[test]
    fn quick_look_runs_only_for_listed_kinds() {
        let ql = fake(Ok(PNG.to_vec()));
        for ext in QUICK_EXTS { assert!(build(b"plain",&format!("file.{ext}"),128,false,&ql,Path::new("unused")).is_ok()); }
        assert_eq!(ql.calls.get(),QUICK_EXTS.len());
        assert_eq!(build(b"plain","file.zip",128,false,&ql,Path::new("unused")).unwrap_err(),Reason::Unsupported);
        assert_eq!(ql.calls.get(),QUICK_EXTS.len());
    }
    #[test]
    fn every_quick_look_extension_is_a_known_kind_that_may_open() {
        for ext in QUICK_EXTS.iter().chain([&"psd"]) { let kind=kinds::lookup(&format!("x.{ext}")); assert_eq!(kind.ext,*ext); assert_ne!(kind.open,kinds::OpenPolicy::Deny); }
    }
    #[test]
    fn deny_kinds_never_reach_quick_look() {
        let ql=fake(Ok(PNG.to_vec()));
        assert_eq!(build(b"%PDF-1.7","x.pdf",128,true,&ql,Path::new("unused")).unwrap_err(),Reason::Unsupported);
        assert_eq!(ql.calls.get(),0);
    }
    #[test]
    fn a_quick_look_timeout_is_timed_out_and_not_cached() {
        let root=TempDir::new(); let cache=TempDir::new(); let ql=fake(Err(Reason::TimedOut));
        fs::write(root.path().join("a.pdf"),b"%PDF-1.7").unwrap();
        for _ in 0..2 { assert_eq!(read_at(root.path(),cache.path(),"a.pdf",&ql).unwrap_err(),Reason::TimedOut); }
        assert_eq!(ql.calls.get(),2);
        assert!(!cache.path().join("thumbs/v1").exists() || fs::read_dir(cache.path().join("thumbs/v1")).unwrap().next().is_none());
    }
    #[test]
    fn a_path_outside_the_root_is_not_found() {
        let root=TempDir::new(); let cache=TempDir::new();
        assert_eq!(read_at(root.path(),cache.path(),"../outside.png",&fake(Ok(PNG.to_vec()))).unwrap_err(),Reason::NotFound);
    }
    #[test]
    fn the_cache_prunes_oldest_past_its_cap() {
        let root=TempDir::new();
        for (name,seconds) in [("old.png",1),("new.png",2)] {
            let file=fs::File::create(root.path().join(name)).unwrap(); file.set_len(10).unwrap();
            file.set_times(fs::FileTimes::new().set_modified(UNIX_EPOCH+std::time::Duration::from_secs(seconds))).unwrap();
        }
        prune(root.path(),10);
        assert!(!root.path().join("old.png").exists()); assert!(root.path().join("new.png").exists());
    }
    #[test]
    #[cfg(target_os="macos")]
    #[ignore = "opt-in native Quick Look proof against a generated file, outside the vault"]
    fn real_quick_look_makes_a_png() {
        let cache=TempDir::new(); let data=testdocs::docx();
        let result=NativeQuickLook.run(&data,"docx",128,cache.path()).unwrap();
        assert!(result.starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
impl Preview {
    fn answer(self) -> Thumbnail {
        Thumbnail::Ready {
            data_url: format!(
                "data:{};base64,{}",
                self.picture.mime,
                base64::engine::general_purpose::STANDARD.encode(&self.picture.bytes)
            ),
            width: self.picture.width,
            height: self.picture.height,
            source: self.source,
        }
    }
}
pub fn snap(size: u32) -> u32 {
    if size <= 128 {
        128
    } else if size <= 256 {
        256
    } else {
        512
    }
}
fn image_error(failure: images::Failure) -> Reason {
    match failure {
        images::Failure::TooLarge => Reason::TooLarge,
        images::Failure::Corrupt => Reason::Corrupt,
        images::Failure::Unsupported(_) => Reason::Unsupported,
    }
}
fn package_error(failure: extract::Failure) -> Reason {
    match failure {
        extract::Failure::TooLarge { .. } => Reason::TooLarge,
        extract::Failure::Unsupported { .. } => Reason::Unsupported,
        _ => Reason::Corrupt,
    }
}

struct Slots {
    count: Mutex<usize>,
    available: Condvar,
    max: usize,
}
struct Slot(&'static Slots);
impl Slots {
    const fn new(max: usize) -> Self {
        Self {
            count: Mutex::new(0),
            available: Condvar::new(),
            max,
        }
    }
    fn take(&'static self) -> Slot {
        let mut count = self.count.lock().unwrap_or_else(|e| e.into_inner());
        while *count >= self.max {
            count = self
                .available
                .wait(count)
                .unwrap_or_else(|e| e.into_inner());
        }
        *count += 1;
        Slot(self)
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        *self.0.count.lock().unwrap_or_else(|e| e.into_inner()) -= 1;
        self.0.available.notify_one();
    }
}
static DECODES: Slots = Slots::new(4);
static QUICK_LOOK: Slots = Slots::new(2);

fn stamp(meta: &Metadata) -> Option<(u64, u128)> {
    Some((
        meta.len(),
        meta.modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    ))
}
fn key(opened: &OpenedFile, meta: &Metadata, size: u32) -> Option<String> {
    let (length, modified) = stamp(meta)?;
    let mut hash = Sha256::new();
    hash.update(opened.path.as_os_str().as_encoded_bytes());
    hash.update([0]);
    hash.update(length.to_le_bytes());
    hash.update(modified.to_le_bytes());
    hash.update(size.to_le_bytes());
    hash.update(b"thumb-v1");
    Some(format!("{:x}", hash.finalize()))
}
#[derive(Serialize, Deserialize)]
struct Cached {
    width: u32,
    height: u32,
    source: Source,
    png: bool,
}
fn bounded_file(path: &Path, cap: u64) -> Option<Vec<u8>> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).ok()?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > cap {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(cap + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= cap).then_some(bytes)
}
fn cached(dir: &Path, key: &str) -> Option<Result<Preview, Reason>> {
    if let Some(bytes) = bounded_file(&dir.join(format!("{key}.none")), 128) {
        let reason: Reason = serde_json::from_slice(&bytes).ok()?;
        return reason.cached().then_some(Err(reason));
    }
    let meta: Cached =
        serde_json::from_slice(&bounded_file(&dir.join(format!("{key}.json")), 1024)?).ok()?;
    if meta.width == 0 || meta.height == 0 || meta.width > 512 || meta.height > 512 {
        return None;
    }
    let ext = if meta.png { "png" } else { "jpg" };
    let bytes = bounded_file(&dir.join(format!("{key}.{ext}")), OUTPUT_CAP)?;
    Some(Ok(Preview {
        picture: images::Prepared {
            bytes,
            mime: if meta.png { "image/png" } else { "image/jpeg" },
            width: meta.width,
            height: meta.height,
        },
        source: meta.source,
    }))
}
fn atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let temp = path.with_extension(format!("{}.tmp", crate::ledger::new_run_id()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temp)?;
        file.write_all(bytes)?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn store(dir: &Path, key: &str, result: &Result<Preview, Reason>) {
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    match result {
        Ok(preview) => {
            let png = preview.picture.mime == "image/png";
            let ext = if png { "png" } else { "jpg" };
            if atomic(&dir.join(format!("{key}.{ext}")), &preview.picture.bytes).is_err() {
                return;
            }
            let meta = Cached {
                width: preview.picture.width,
                height: preview.picture.height,
                source: preview.source,
                png,
            };
            if let Ok(bytes) = serde_json::to_vec(&meta) {
                let _ = atomic(&dir.join(format!("{key}.json")), &bytes);
            }
        }
        Err(reason) if reason.cached() => {
            if let Ok(bytes) = serde_json::to_vec(reason) {
                let _ = atomic(&dir.join(format!("{key}.none")), &bytes);
            }
        }
        Err(_) => return,
    }
    static PRUNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if PRUNING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return;
    }
    let dir = dir.to_path_buf();
    if std::thread::Builder::new()
        .name("cerebro-thumb-prune".into())
        .spawn(move || {
            prune(&dir, CACHE_CAP);
            PRUNING.store(false, std::sync::atomic::Ordering::Release);
        })
        .is_err()
    {
        PRUNING.store(false, std::sync::atomic::Ordering::Release);
    }
}
fn prune(dir: &Path, cap: u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let meta = fs::symlink_metadata(&path).ok()?;
            if !meta.is_file()
                || !matches!(path.extension()?.to_str()?, "png" | "jpg" | "json" | "none")
            {
                return None;
            }
            Some((meta.modified().unwrap_or(UNIX_EPOCH), path, meta.len()))
        })
        .collect::<Vec<_>>();
    let mut total = files.iter().map(|(_, _, size)| size).sum::<u64>();
    files.sort_by_key(|(time, _, _)| *time);
    for (_, path, size) in files {
        if total <= cap {
            break;
        }
        if fs::remove_file(path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

pub fn thumbnail(config: &Path, cache: &Path, root: &str, path: &str, size: u32) -> Thumbnail {
    let result = bytes::locate(config, root, path)
        .map_err(|_| Reason::NotFound)
        .and_then(|opened| read(opened, cache, snap(size), &NativeQuickLook));
    match result {
        Ok(preview) => preview.answer(),
        Err(reason) => Thumbnail::None { reason },
    }
}
fn read(
    mut opened: OpenedFile,
    cache: &Path,
    size: u32,
    quick: &dyn QuickLook,
) -> Result<Preview, Reason> {
    let meta = opened.file.metadata().map_err(|_| Reason::NotFound)?;
    let key = key(&opened, &meta, size).ok_or(Reason::NotFound)?;
    let dir = cache.join("thumbs/v1");
    if let Some(hit) = cached(&dir, &key) {
        return hit;
    }
    let _slot = DECODES.take();
    if let Some(hit) = cached(&dir, &key) {
        return hit;
    }
    let result = if meta.len() > INPUT_CAP {
        Err(Reason::TooLarge)
    } else {
        opened
            .file
            .seek(SeekFrom::Start(0))
            .map_err(|_| Reason::NotFound)?;
        let mut bytes = Vec::new();
        (&mut opened.file)
            .take(INPUT_CAP + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Reason::NotFound)?;
        if bytes.len() as u64 > INPUT_CAP {
            Err(Reason::TooLarge)
        } else {
            let name = opened
                .path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            let deny = kinds::open_policy_for(name, &meta, Some(&bytes)) == kinds::OpenPolicy::Deny;
            build(&bytes, name, size, deny, quick, cache)
        }
    };
    if stamp(&opened.file.metadata().map_err(|_| Reason::NotFound)?) != stamp(&meta) {
        return Err(Reason::NotFound);
    }
    store(&dir, &key, &result);
    result
}
fn build(
    bytes: &[u8],
    name: &str,
    size: u32,
    deny: bool,
    quick: &dyn QuickLook,
    cache: &Path,
) -> Result<Preview, Reason> {
    let ext = kinds::ext_of(name).unwrap_or_default();
    let (picture, source) = if bytes.starts_with(b"8BPS") {
        match psd_preview(bytes)? {
            Some((data, swap)) => (
                images::thumbnail(data, size, swap).map_err(image_error)?,
                Source::Psd,
            ),
            None => (
                quick_picture(bytes, "psd", size, deny, quick, cache)?,
                Source::QuickLook,
            ),
        }
    } else if images::is_raster(bytes) {
        (
            images::thumbnail(bytes, size, false).map_err(image_error)?,
            Source::Image,
        )
    } else if ext == "fig" {
        let picture = if bytes.starts_with(b"PK") {
            package::read_entry(bytes.to_vec(), "thumbnail.png", PREVIEW_CAP)
                .map_err(package_error)?
        } else {
            legacy_fig(bytes)?.map(<[u8]>::to_vec)
        }
        .ok_or(Reason::NoPreview)?;
        if !picture.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(Reason::Corrupt);
        }
        (
            images::thumbnail(&picture, size, false).map_err(image_error)?,
            Source::Fig,
        )
    } else if QUICK_EXTS.contains(&ext.as_str()) {
        (
            quick_picture(bytes, &ext, size, deny, quick, cache)?,
            Source::QuickLook,
        )
    } else {
        return Err(Reason::Unsupported);
    };
    Ok(Preview { picture, source })
}
fn take<'a>(bytes: &'a [u8], at: &mut usize, len: usize) -> Result<&'a [u8], Reason> {
    let end = at.checked_add(len).ok_or(Reason::Corrupt)?;
    let part = bytes.get(*at..end).ok_or(Reason::Corrupt)?;
    *at = end;
    Ok(part)
}
fn be32(bytes: &[u8], at: &mut usize) -> Result<u32, Reason> {
    Ok(u32::from_be_bytes(
        take(bytes, at, 4)?
            .try_into()
            .map_err(|_| Reason::Corrupt)?,
    ))
}
fn legacy_fig(bytes: &[u8]) -> Result<Option<&[u8]>, Reason> {
    if !bytes.starts_with(b"fig-") {
        return Err(Reason::Corrupt);
    }
    let mut at = 12;
    for index in 0..3 {
        if at == bytes.len() {
            return Ok(None);
        }
        let len = u32::from_le_bytes(
            take(bytes, &mut at, 4)?
                .try_into()
                .map_err(|_| Reason::Corrupt)?,
        ) as usize;
        if index == 2 && len as u64 > PREVIEW_CAP {
            return Err(Reason::TooLarge);
        }
        let data = take(bytes, &mut at, len)?;
        if index == 2 {
            return Ok(Some(data));
        }
    }
    Ok(None)
}
/// Adobe's image-resource framing and 28-byte JFIF preview header:
/// https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/
fn psd_preview(bytes: &[u8]) -> Result<Option<(&[u8], bool)>, Reason> {
    if bytes.get(4..6) != Some(&[0, 1]) {
        return Err(Reason::Corrupt);
    }
    let mut at = 26;
    let color = be32(bytes, &mut at)? as usize;
    take(bytes, &mut at, color)?;
    let resource_len = be32(bytes, &mut at)? as usize;
    let resources = take(bytes, &mut at, resource_len)?;
    let mut pos = 0;
    let mut older = None;
    while pos < resources.len() {
        if take(resources, &mut pos, 4)? != b"8BIM" {
            return Err(Reason::Corrupt);
        }
        let id = u16::from_be_bytes(
            take(resources, &mut pos, 2)?
                .try_into()
                .map_err(|_| Reason::Corrupt)?,
        );
        let name = usize::from(take(resources, &mut pos, 1)?[0]);
        take(resources, &mut pos, name + usize::from((name + 1) % 2 != 0))?;
        let len = be32(resources, &mut pos)? as usize;
        let data = take(resources, &mut pos, len)?;
        take(resources, &mut pos, len % 2)?;
        if id != 1036 && id != 1033 {
            continue;
        }
        if data.len() < 28 {
            return Err(Reason::Corrupt);
        }
        let mut header = 0;
        if be32(data, &mut header)? != 1 {
            continue;
        }
        header = 20;
        let length = be32(data, &mut header)? as usize;
        if length as u64 > PREVIEW_CAP {
            return Err(Reason::TooLarge);
        }
        header = 28;
        let jpeg = take(data, &mut header, length)?;
        if !jpeg.starts_with(&[0xff, 0xd8, 0xff]) {
            return Err(Reason::Corrupt);
        }
        if id == 1036 {
            return Ok(Some((jpeg, false)));
        }
        older = Some((jpeg, true));
    }
    Ok(older)
}

trait QuickLook {
    fn run(&self, bytes: &[u8], ext: &str, size: u32, cache: &Path) -> Result<Vec<u8>, Reason>;
}
struct NativeQuickLook;
fn quick_picture(
    bytes: &[u8],
    ext: &str,
    size: u32,
    deny: bool,
    quick: &dyn QuickLook,
    cache: &Path,
) -> Result<images::Prepared, Reason> {
    if deny {
        return Err(Reason::Unsupported);
    }
    let _slot = QUICK_LOOK.take();
    let bytes = quick.run(bytes, ext, size, cache)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(Reason::TooLarge);
    }
    images::thumbnail(&bytes, size, false).map_err(image_error)
}
#[cfg(not(target_os = "macos"))]
impl QuickLook for NativeQuickLook {
    fn run(&self, _bytes: &[u8], _ext: &str, _size: u32, _cache: &Path) -> Result<Vec<u8>, Reason> {
        Err(Reason::ToolMissing)
    }
}
#[cfg(target_os = "macos")]
impl QuickLook for NativeQuickLook {
    fn run(&self, bytes: &[u8], ext: &str, size: u32, cache: &Path) -> Result<Vec<u8>, Reason> {
        use std::os::unix::fs::DirBuilderExt;
        let parent = cache.join("thumbs/work");
        fs::create_dir_all(&parent).map_err(|_| Reason::NoPreview)?;
        let path = parent.join(crate::ledger::new_run_id());
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&path)
            .map_err(|_| Reason::NoPreview)?;
        struct Temporary(std::path::PathBuf);
        impl Drop for Temporary {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let temp = Temporary(path);
        let input = temp.0.join(format!("preview.{ext}"));
        atomic(&input, bytes).map_err(|_| Reason::NoPreview)?;
        let mut command = crate::spawn::command("/usr/bin/qlmanage");
        command
            .args(["-t", "-s", &size.to_string(), "-o"])
            .arg(&temp.0)
            .arg(&input);
        match crate::spawn::wait_within(&mut command, std::time::Duration::from_secs(5)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(Reason::ToolMissing)
            }
            Err(_) => return Err(Reason::NoPreview),
            Ok(None) => return Err(Reason::TimedOut),
            Ok(Some(status)) if !status.success() => return Err(Reason::NoPreview),
            Ok(_) => {}
        }
        let output = temp.0.join(format!("preview.{ext}.png"));
        bounded_file(&output, 4 * 1024 * 1024).ok_or(Reason::NoPreview)
    }
}
