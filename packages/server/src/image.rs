//! Sync image-processing helpers. Always invoked from
//! `tokio::task::spawn_blocking` because decode + resize + encode is CPU-bound
//! and would otherwise stall the tokio worker. Mirrors the Node
//! `lib/image-server.ts` contract — same filenames, same widths, same 9
//! variants per upload (skipping GIFs).

use std::path::Path;

use image::imageops::FilterType;

/// Widths to generate for responsive images. Heights are 16:9.
const VARIANT_WIDTHS: [u32; 3] = [400, 800, 1200];

/// Compute the 16:9 height for a given width, rounded to nearest integer.
fn height_for(width: u32) -> u32 {
    (width as f64 * 9.0 / 16.0).round() as u32
}

/// Decode `input`, then for each variant width write three files into
/// `uploads_dir`:
///
/// - `{uuid}-{w}.webp` — pure-Rust WebP encoder (via the `image` crate's webp
///   feature). Roughly libwebp-default quality.
/// - `{uuid}-{w}.jpg` — JPEG quality 80.
/// - `{uuid}-{w}-gray.jpg` — grayscale JPEG quality 80, for `@media (monochrome)`
///   / e-ink rendering.
///
/// Skips widths greater than `2 * original_width` to avoid heavy upscaling.
/// Skips entirely for GIFs (preserves animation; matches sharp's behavior).
///
/// Filter choice: `Triangle` (bilinear) is fast enough for Pi 3 and visually
/// identical to Lanczos at the 1200-pixel max width we ship.
pub fn process_uploaded_image(
    input: &Path,
    uploads_dir: &Path,
    uuid: &str,
) -> anyhow::Result<()> {
    let ext = input
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if ext == "gif" {
        return Ok(());
    }

    let img = image::ImageReader::open(input)?
        .with_guessed_format()?
        .decode()?;
    let original_width = img.width();

    for &w in &VARIANT_WIDTHS {
        // TS guard: `if (originalWidth * 2 < width) continue;`
        if original_width.saturating_mul(2) < w {
            continue;
        }
        let h = height_for(w);
        let resized = img.resize_to_fill(w, h, FilterType::Triangle);
        write_webp(&resized, &uploads_dir.join(format!("{uuid}-{w}.webp")))?;
        write_jpeg(&resized, &uploads_dir.join(format!("{uuid}-{w}.jpg")), 80)?;
        let gray = resized.grayscale();
        write_jpeg(&gray, &uploads_dir.join(format!("{uuid}-{w}-gray.jpg")), 80)?;
        // Explicit drop so the next iteration's resized buffer doesn't have
        // to share memory with the previous one. Matters on a 1 GB Pi 3 when
        // the source is a 12 MP photo.
        drop(resized);
        drop(gray);
    }
    Ok(())
}

fn write_jpeg(img: &image::DynamicImage, path: &Path, quality: u8) -> anyhow::Result<()> {
    let file = std::fs::File::create(path)?;
    let mut writer = std::io::BufWriter::new(file);
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, quality);
    enc.encode_image(img)?;
    Ok(())
}

fn write_webp(img: &image::DynamicImage, path: &Path) -> anyhow::Result<()> {
    img.save_with_format(path, image::ImageFormat::WebP)?;
    Ok(())
}

/// Copy the 400-pixel JPEG variant to `{slug}.jpg` so calendar ICS exports
/// have a readable filename (iOS Calendar shows the filename verbatim).
/// Retries up to 5× at 1s intervals because variants are generated in the
/// background — the source file may not exist yet when this is called
/// immediately after `createRecipe`. Mirrors `copyFriendlyPhoto` in TS.
pub fn copy_friendly_photo(photo_url: &str, slug: &str, uploads_dir: &Path) {
    if !photo_url.starts_with("/uploads/") || slug.is_empty() {
        return;
    }
    let stem = photo_url
        .trim_start_matches("/uploads/")
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or_default();
    if stem.is_empty() {
        return;
    }
    let src = uploads_dir.join(format!("{stem}-400.jpg"));
    let dest = uploads_dir.join(format!("{slug}.jpg"));
    for _ in 0..5 {
        if src.exists() {
            let _ = std::fs::copy(&src, &dest);
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn height_for_16_9() {
        assert_eq!(height_for(400), 225);
        assert_eq!(height_for(800), 450);
        assert_eq!(height_for(1200), 675);
    }

    #[test]
    fn process_real_jpeg_generates_nine_variants() {
        let dir = tempdir();
        let input_path = dir.join("source.jpg");
        write_test_jpeg(&input_path, 2000, 1500);
        process_uploaded_image(&input_path, &dir, "abc").expect("process");
        for w in [400, 800, 1200] {
            assert!(dir.join(format!("abc-{w}.webp")).exists(), "{w}.webp missing");
            assert!(dir.join(format!("abc-{w}.jpg")).exists(), "{w}.jpg missing");
            assert!(
                dir.join(format!("abc-{w}-gray.jpg")).exists(),
                "{w}-gray.jpg missing"
            );
        }
    }

    #[test]
    fn process_skips_oversized_widths() {
        let dir = tempdir();
        let input_path = dir.join("source.jpg");
        // 300×225 source. 2× = 600 → 400 emitted, 800 + 1200 skipped.
        write_test_jpeg(&input_path, 300, 225);
        process_uploaded_image(&input_path, &dir, "tiny").expect("process");
        assert!(dir.join("tiny-400.webp").exists());
        assert!(!dir.join("tiny-800.webp").exists());
        assert!(!dir.join("tiny-1200.webp").exists());
    }

    #[test]
    fn process_skips_gif() {
        let dir = tempdir();
        let input_path = dir.join("source.gif");
        std::fs::write(&input_path, b"GIF89a").unwrap();
        process_uploaded_image(&input_path, &dir, "anim").expect("process");
        assert!(!dir.join("anim-400.webp").exists());
    }

    fn tempdir() -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!(
            "pantry-server-image-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&base).unwrap();
        base
    }

    fn write_test_jpeg(path: &Path, w: u32, h: u32) {
        let img = image::DynamicImage::new_rgb8(w, h);
        img.save_with_format(path, image::ImageFormat::Jpeg).unwrap();
    }
}
