# 🍳 ImageChef

**Client-side batch image processor — nothing leaves your browser.**

ImageChef is a single-page tool for batch-processing images entirely in your browser. Drop a folder of photos, build a recipe of operations, hit Bake, and download the results as a ZIP. No server, no uploads, no accounts.

## Features

- **Resize** — fit within max W×H, exact dimensions, percentage scale, or longest-edge cap
- **Compress** — binary-search compression to hit a per-image size cap or a total batch budget (e.g. "whole batch ≤ 20 MB" for email)
- **Format convert** — output as JPEG, WebP, PNG, or keep the original format
- **Strip metadata** — EXIF/GPS is dropped automatically on re-encode; surfaced as an explicit recipe step so you know it happened
- **Rename** — pattern-based rename with `{name}`, `{index}`, `{width}x{height}`, `{date}` tokens
- **Email preset** — one click to configure longest-edge 1600 px + total budget 20 MB + JPEG output
- **Before/after preview** — side-by-side comparison with synchronized zoom (scroll) and pan (drag) so you can inspect compression artifacts up close
- **Light & dark themes** — System / Light / Dark selector in the header, defaulting to System, which follows your OS color-scheme setting and updates live when it changes; an explicit choice is remembered across visits
- **Recipe sharing via URL hash** — the recipe, ZIP name, and rename pattern are stored in the URL hash, so bookmarking or sharing the link restores your setup

## Usage

1. Open `index.html` in any modern browser — no install, no build step
2. Drop images or a ZIP archive onto the drop zone (or click to browse)
3. Build a recipe in the left panel: add operations, configure each one
4. Click **🍳 Bake!**
5. Download results as a **ZIP** or individually

## Architecture

ImageChef is a single self-contained `index.html` file — all CSS and JavaScript are inline. The only external dependency is [JSZip](https://stashofcode.fr/jszip/) loaded via CDN with an SRI hash.

All image processing uses native browser APIs (`createImageBitmap`, `OffscreenCanvas`, `canvas.toBlob`). A concurrency pool of 3 workers processes files in parallel without saturating RAM on large batches.

**Privacy:** images never leave the device. There is no backend.

## Deployment

Drop `index.html` anywhere that serves static files:

- **Cloudflare Pages** — push to a repo, done
- **Any static host** — single file, no dependencies to install
- **Locally** — open the file directly in a browser (`file://` works for everything except folder drag-and-drop, which requires a server origin in some browsers)

## Browser support

Any modern browser with `createImageBitmap` and `OffscreenCanvas` support (Chrome 69+, Firefox 105+, Safari 16.4+). HEIC input is handled via a lazily-loaded WASM library and requires a network connection on first use.

## Roadmap

Crop/pad to aspect ratio · watermark overlay · AVIF output · PWA/offline mode
