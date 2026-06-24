# 🍳 ImageChef

**Client-side batch image processor — nothing leaves your browser.**

ImageChef is a single-page tool for batch-processing images entirely in your browser. Drop a folder of photos, build a recipe of operations, hit Bake, and download the results as a ZIP. No server, no uploads, no accounts.

## Features

- **Resize** — fit within max W×H, exact dimensions, percentage scale, or longest-edge cap
- **Compress** — binary-search compression to hit a per-image size cap or a total batch budget (e.g. "whole batch ≤ 20 MB" for email)
- **Format convert** — output as JPEG, WebP, or PNG; or keep the original format (alpha-channel images are automatically promoted to PNG when converting to JPEG)
- **Strip metadata** — EXIF/GPS is dropped on re-encode; surfaced as an explicit recipe step so you know it happened
- **Rename** — pattern-based rename with `{name}`, `{index}`, `{width}x{height}`, `{date}` tokens
- **Rotate / Flip** — rotate 90°/180°/270° and flip horizontally or vertically
- **Grayscale** — luminance (BT.601) or average method
- **Remove Duplicates** — skip duplicate files during bake, matched by name+size or name only; duplicates are flagged in the status column rather than silently dropped
- **Email preset** — one click to configure longest-edge 1600 px + total budget 20 MB + JPEG output
- **Before/after preview** — side-by-side comparison with synchronized zoom (scroll) and pan (drag)
- **Per-file remove** — remove individual files from the list with the ✕ button on each row; "Clear all" still available for the full list
- **Light & dark themes** — System / Light / Dark selector, defaulting to System (follows OS preference live); an explicit choice is remembered across visits
- **Recipe sharing via URL hash** — the recipe, ZIP name, and rename pattern are stored in the URL hash; bookmarking or sharing the link restores your setup

## Supported input formats

JPEG, PNG, WebP, BMP, GIF (first frame), HEIC/HEIF, ZIP archives of images

## Usage

1. Open `index.html` in any modern browser — no install, no build step
2. Drop images, a folder, or a ZIP archive onto the drop zone (or click to browse / use the 📁 Pick files button)
3. Build a recipe in the left panel: add operations, configure each one, drag to reorder
4. Click **🍳 Bake!**
5. Download results as a **ZIP** or individually

## Architecture

ImageChef is a single self-contained `index.html` file — all CSS and JavaScript are inline. External dependencies:

- [JSZip](https://stashofcode.fr/jszip/) — ZIP creation and extraction, loaded via CDN with an SRI hash
- [heic2any](https://alexcorvi.github.io/heic2any/) — HEIC/HEIF decoding via WASM, lazily loaded on first use

All image processing uses native browser APIs (`createImageBitmap`, `canvas`, `canvas.toBlob`). A concurrency pool of 3 workers processes files in parallel without saturating RAM on large batches.

**Privacy:** images never leave the device. There is no backend.

## Deployment

Drop `index.html` anywhere that serves static files:

- **Cloudflare Pages** — push to a repo, done
- **Any static host** — single file, no dependencies to install
- **Locally** — open the file directly in a browser (`file://` works for most features; folder drag-and-drop and OS dark-mode detection may require a server origin in some browsers)

## Browser support

Any modern browser with `createImageBitmap` support (Chrome 69+, Firefox 105+, Safari 16.4+). HEIC input requires a network connection on first use to load the WASM decoder.

## Roadmap

Crop/pad to aspect ratio · watermark overlay · AVIF output · PWA/offline mode
