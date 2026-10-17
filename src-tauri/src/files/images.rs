//! Bounded document-picture decoding. No other module opens an image decoder.
use image::{
    codecs::jpeg::JpegEncoder, metadata::Orientation, DynamicImage, ImageDecoder, ImageFormat,
    ImageReader,
};
use std::io::Cursor;

pub const INPUT_BYTES: u64 = 32 * 1024 * 1024;
const OUTPUT_BYTES: usize = 2 * 1024 * 1024;
const SIDE: u32 = 1080;
const DECODE_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    Unsupported(String),
    TooLarge,
    Corrupt,
}
impl Failure {
    pub fn words(&self) -> String {
        match self {
            Self::Unsupported(kind) => format!("not a picture Cerebro reads ({kind})"),
            Self::TooLarge => "too large to read".into(),
            Self::Corrupt => "could not be decoded".into(),
        }
    }
}
#[derive(Debug)]
pub struct Prepared {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
}
fn failure(error: image::ImageError) -> Failure {
    match error {
        image::ImageError::Limits(_) => Failure::TooLarge,
        _ => Failure::Corrupt,
    }
}
fn unsupported(bytes: &[u8]) -> String {
    if bytes.get(40..44) == Some(b" EMF") {
        "emf".into()
    } else if bytes.starts_with(&[0xd7, 0xcd, 0xc6, 0x9a]) {
        "wmf".into()
    } else {
        image::guess_format(bytes).map_or_else(
            |_| "unknown format".into(),
            |f| format!("{f:?}").to_ascii_lowercase(),
        )
    }
}
/// Always decode under limits, even on the unchanged-PNG path. A PNG header is
/// not proof that its compressed pixels are valid or bounded.
pub fn prepare(bytes: &[u8]) -> Result<Prepared, Failure> {
    prepare_with_cap(bytes, OUTPUT_BYTES)
}

/// Preview work has its own larger decode bound, but a smaller encoded result.
/// `swap_rb` is only Photoshop's old 1033 BGR resource, never inferred from pixels.
pub fn thumbnail(bytes: &[u8], side: u32, swap_rb: bool) -> Result<Prepared, Failure> {
    if bytes.len() > 64 * 1024 * 1024 {
        return Err(Failure::TooLarge);
    }
    let format =
        image::guess_format(bytes).map_err(|_| Failure::Unsupported(unsupported(bytes)))?;
    if !matches!(
        format,
        ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::Gif
            | ImageFormat::WebP
            | ImageFormat::Bmp
    ) {
        return Err(Failure::Unsupported(unsupported(bytes)));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16_384);
    limits.max_image_height = Some(16_384);
    limits.max_alloc = Some(512 * 1024 * 1024);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(failure)?;
    if decoder.total_bytes() > 512 * 1024 * 1024 {
        return Err(Failure::TooLarge);
    }
    let orientation = decoder.orientation().map_err(failure)?;
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(failure)?;
    decoded.apply_orientation(orientation);
    if swap_rb {
        let mut pixels = decoded.to_rgb8();
        for pixel in pixels.pixels_mut() {
            pixel.0.swap(0, 2);
        }
        decoded = DynamicImage::ImageRgb8(pixels);
    }
    let side = side.clamp(1, 512);
    if decoded.width() > side || decoded.height() > side {
        decoded = decoded.thumbnail(side, side);
    }
    loop {
        let mut out = Cursor::new(Vec::new());
        let mime = if decoded.has_alpha() {
            decoded
                .write_to(&mut out, ImageFormat::Png)
                .map_err(failure)?;
            "image/png"
        } else {
            JpegEncoder::new_with_quality(&mut out, 82)
                .encode_image(&decoded)
                .map_err(failure)?;
            "image/jpeg"
        };
        if out.get_ref().len() <= 512 * 1024 {
            return Ok(Prepared {
                bytes: out.into_inner(),
                mime,
                width: decoded.width(),
                height: decoded.height(),
            });
        }
        if decoded.width().max(decoded.height()) <= 1 {
            return Err(Failure::TooLarge);
        }
        decoded = decoded.thumbnail((decoded.width() / 2).max(1), (decoded.height() / 2).max(1));
    }
}

pub fn is_raster(bytes: &[u8]) -> bool {
    matches!(
        image::guess_format(bytes),
        Ok(ImageFormat::Png
            | ImageFormat::Jpeg
            | ImageFormat::Gif
            | ImageFormat::WebP
            | ImageFormat::Bmp)
    )
}
fn prepare_with_cap(bytes: &[u8], output_cap: usize) -> Result<Prepared, Failure> {
    if bytes.len() as u64 > INPUT_BYTES {
        return Err(Failure::TooLarge);
    }
    let format =
        image::guess_format(bytes).map_err(|_| Failure::Unsupported(unsupported(bytes)))?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::Gif | ImageFormat::WebP
    ) {
        return Err(Failure::Unsupported(unsupported(bytes)));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(10_000);
    limits.max_image_height = Some(10_000);
    limits.max_alloc = Some(DECODE_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(failure)?;
    if decoder.total_bytes() > DECODE_BYTES {
        return Err(Failure::TooLarge);
    }
    let orientation = decoder.orientation().map_err(failure)?;
    let mut decoded = DynamicImage::from_decoder(decoder).map_err(failure)?;
    decoded.apply_orientation(orientation);
    let original_size = (decoded.width(), decoded.height());
    if original_size.0 > SIDE || original_size.1 > SIDE {
        decoded = decoded.thumbnail(SIDE, SIDE);
    }
    let (width, height) = (decoded.width(), decoded.height());
    if format == ImageFormat::Png
        && original_size == (width, height)
        && orientation == Orientation::NoTransforms
        && bytes.len() <= output_cap
    {
        return Ok(Prepared {
            bytes: bytes.to_vec(),
            mime: "image/png",
            width,
            height,
        });
    }
    if decoded.has_alpha() {
        let mut png = Cursor::new(Vec::new());
        decoded
            .write_to(&mut png, ImageFormat::Png)
            .map_err(failure)?;
        let png = png.into_inner();
        if png.len() <= output_cap {
            return Ok(Prepared {
                bytes: png,
                mime: "image/png",
                width,
                height,
            });
        }
    }
    // Above the encoded PNG cap, flatten transparency onto white before JPEG;
    // otherwise discarded alpha can turn transparent pixels into black marks.
    let rgb = if decoded.has_alpha() {
        let rgba = decoded.to_rgba8();
        image::RgbImage::from_fn(width, height, |x, y| {
            let p = rgba.get_pixel(x, y);
            let a = u32::from(p[3]);
            image::Rgb(
                [0, 1, 2].map(|i| ((u32::from(p[i]) * a + 255 * (255 - a) + 127) / 255) as u8),
            )
        })
    } else {
        decoded.to_rgb8()
    };
    let mut jpeg = Vec::new();
    JpegEncoder::new_with_quality(&mut jpeg, 85)
        .encode_image(&rgb)
        .map_err(failure)?;
    if jpeg.len() > output_cap {
        return Err(Failure::TooLarge);
    }
    Ok(Prepared {
        bytes: jpeg,
        mime: "image/jpeg",
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn png(width: u32, height: u32, alpha: bool) -> Vec<u8> {
        let picture = if alpha {
            DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                width,
                height,
                image::Rgba([20, 80, 120, 80]),
            ))
        } else {
            DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
                width,
                height,
                image::Rgb([20, 80, 120]),
            ))
        };
        let mut out = Cursor::new(Vec::new());
        picture.write_to(&mut out, ImageFormat::Png).unwrap();
        out.into_inner()
    }
    #[test]
    fn a_wide_picture_comes_back_at_1080_on_its_longest_side() {
        let p = prepare(&png(3000, 600, false)).unwrap();
        assert_eq!((p.width, p.height), (1080, 216));
    }
    #[test]
    fn a_small_png_passes_through_unchanged() {
        let bytes = png(32, 16, true);
        assert_eq!(prepare(&bytes).unwrap().bytes, bytes);
    }
    #[test]
    fn a_picture_is_never_upscaled() {
        let p = prepare(&png(8, 4, false)).unwrap();
        assert_eq!((p.width, p.height), (8, 4));
    }
    #[test]
    fn transparency_stays_png_and_an_opaque_photo_becomes_jpeg() {
        assert_eq!(prepare(&png(1200, 600, true)).unwrap().mime, "image/png");
        assert_eq!(prepare(&png(1200, 600, false)).unwrap().mime, "image/jpeg");
    }
    #[test]
    fn an_emf_is_named_not_decoded() {
        let mut b = vec![0; 44];
        b[40..44].copy_from_slice(b" EMF");
        assert_eq!(prepare(&b).unwrap_err(), Failure::Unsupported("emf".into()));
    }
    #[test]
    fn a_png_declaring_50000_square_is_refused_by_the_limits() {
        // PNG signature + IHDR; the parser's size guard runs before pixel decode.
        let mut bytes = png(1, 1, false);
        bytes[16..20].copy_from_slice(&50_000u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&50_000u32.to_be_bytes());
        // Keep the header checksum valid so the limit is the reason for refusal.
        let mut crc = 0xffff_ffffu32;
        for b in &bytes[12..29] {
            crc ^= u32::from(*b);
            for _ in 0..8 {
                crc = (crc >> 1) ^ if crc & 1 == 1 { 0xedb8_8320 } else { 0 };
            }
        }
        bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
        assert_eq!(prepare(&bytes).unwrap_err(), Failure::TooLarge);
    }
    #[test]
    fn an_oversized_png_falls_back_to_jpeg() {
        let picture = DynamicImage::ImageRgba8(image::RgbaImage::from_fn(128, 128, |x, y| {
            image::Rgba([
                (x * 17 + y * 31) as u8,
                (x * 3 + y * 7) as u8,
                (x * 11 + y * 13) as u8,
                150,
            ])
        }));
        let mut bytes = Cursor::new(Vec::new());
        picture.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let result = prepare_with_cap(bytes.get_ref(), 15_000).unwrap();
        assert_eq!(result.mime, "image/jpeg");
        assert!(result.bytes.len() <= 15_000);
    }
    #[test]
    fn corrupt_pixels_are_not_passed_through_as_a_small_png() {
        let mut bytes = png(32, 32, false);
        bytes.truncate(40);
        assert_eq!(prepare(&bytes).unwrap_err(), Failure::Corrupt);
    }
    #[test]
    fn exif_orientation_is_applied_before_the_size_is_reported() {
        let mut jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut jpeg, 85)
            .encode_image(&image::RgbImage::from_pixel(
                8,
                4,
                image::Rgb([100, 50, 20]),
            ))
            .unwrap();
        let exif = b"Exif\0\0II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0\x06\0\0\0\0\0\0\0";
        let mut oriented = vec![0xff, 0xd8, 0xff, 0xe1];
        oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        oriented.extend_from_slice(exif);
        oriented.extend_from_slice(&jpeg[2..]);
        let result = prepare(&oriented).unwrap();
        assert_eq!((result.width, result.height), (4, 8));
        let thumb = thumbnail(&oriented, 128, false).unwrap();
        assert_eq!((thumb.width, thumb.height), (4, 8));
    }

    #[test]
    fn thumbnails_never_upscale_and_output_stays_under_its_cap() {
        let small = thumbnail(&png(8, 4, true), 512, false).unwrap();
        assert_eq!((small.width, small.height), (8, 4));
        let picture = DynamicImage::ImageRgba8(image::RgbaImage::from_fn(512, 512, |x, y| {
            image::Rgba([
                (x * 17 + y * 31) as u8,
                (x * 3 + y * 7) as u8,
                (x * 11 + y * 13) as u8,
                (x * 7 + y * 19) as u8,
            ])
        }));
        let mut bytes = Cursor::new(Vec::new());
        picture.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let result = thumbnail(bytes.get_ref(), 512, false).unwrap();
        assert!(result.bytes.len() <= 512 * 1024);
        assert!(result.width <= 512);
        assert_eq!(result.mime, "image/png");
    }

    #[test]
    fn a_bomb_header_is_too_large_without_allocating() {
        let mut bytes = png(1, 1, false);
        bytes[16..20].copy_from_slice(&100_000_u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&100_000_u32.to_be_bytes());
        let mut crc = 0xffff_ffff_u32;
        for b in &bytes[12..29] {
            crc ^= u32::from(*b);
            for _ in 0..8 {
                crc = (crc >> 1) ^ if crc & 1 == 1 { 0xedb8_8320 } else { 0 };
            }
        }
        bytes[29..33].copy_from_slice(&(!crc).to_be_bytes());
        assert_eq!(
            thumbnail(&bytes, 128, false).unwrap_err(),
            Failure::TooLarge
        );
    }
}
