# ImageChef — Bulk Image Manipulation in the Browser

*Design outline. CyberChef's model (composable recipe of operations, everything client-side, one self-contained page) applied to batch image processing.*

---

## 1. Constraints & Architecture

**Deployment target:** A single `index.html` served as a static asset from Cloudflare Pages or Workers (`assets` binding / `env.ASSETS.fetch`). No server-side processing — Workers can't do image decode/encode on the free tier anyway (no native codecs, CPU-time limits), and shipping images to a server defeats the privacy point. Everything happens in the browser.

**Consequences:**
- All CSS and first-party JS inline in the one HTML file.
- Third-party libraries via CDN `<script>` tags (cdnjs/jsdelivr) with SRI hashes — pinned versions, no build step.
- No persistence needed; optional: serialize recipe to URL hash for shareable presets (CyberChef does exactly this).
- Works offline after first load if you later bolt on a service worker — out of scope for v1.

**Core engine:** Canvas / `OffscreenCanvas` + `createImageBitmap()`. Native browser codecs handle JPEG/PNG/WebP decode and JPEG/WebP/PNG encode. No WASM codec libraries needed for v1.

## 2. Libraries (CDN)

| Library | Purpose | Why |
|---|---|---|
| **JSZip** (~100 KB) | Bundle output into one downloadable .zip | Only hard dependency. Battle-tested, on cdnjs. |
| *(optional)* **heic2any** | Decode iPhone HEIC | Heavy (~1 MB WASM). Lazy-load only when a `.heic` file is encountered. |
| *(none for resize/compress)* | — | Canvas `toBlob(type, quality)` does the encoding; no need for browser-image-compression — its core loop is ~30 lines we control better ourselves. |

## 3. Input

- `<input type="file" webkitdirectory multiple>` — folder picker, works everywhere.
- Drag-and-drop zone: walk `DataTransferItem.webkitGetAsEntry()` recursively so dropped *folders* enumerate properly (plain `dataTransfer.files` flattens or misses subfolders depending on browser).
- Filter by MIME/extension: jpeg, png, webp, gif (first frame), bmp, heic (lazy path).
- Preserve relative paths for the ZIP output so folder structure survives round-trip.
- File list UI: name, original dimensions (read lazily), original size, per-file status (queued / processing / done / failed), thumbnail.

## 4. Recipe Model (the CyberChef part)

Ordered list of operations applied per image. Drag to reorder, toggle on/off. v1 operations:

1. **Resize**
   - Modes: fit within max W×H (aspect preserved), exact dimensions, percentage scale, longest-edge cap.
   - Never upscale (checkbox, default on).
   - Quality: `createImageBitmap(file, { resizeQuality: 'high', imageOrientation: 'from-image' })` — gets EXIF rotation correct for free. For large downscale ratios (>2×), stepped halving via intermediate canvases avoids aliasing in browsers with poor single-pass resampling.

2. **Compress to target size**
   - Two modes:
     - **Per-image cap** (e.g. "each ≤ 500 KB")
     - **Total budget** (e.g. "whole batch ≤ 20 MB — for email"). Allocate per-image budget proportional to pixel area, then run per-image solver.
   - Solver: binary search on JPEG/WebP `quality` parameter via `canvas.toBlob(cb, 'image/jpeg', q)`. Search q ∈ [0.3, 0.95], ~6 iterations converges to within a few KB. If even q=0.3 overshoots, fall back to scaling dimensions down (×0.9 steps) and re-search — guarantees the target is met rather than failing.
   - PNG input: offer auto-convert to JPEG/WebP (PNG quality isn't tunable); preserve PNG only if "keep transparency" detected/selected — alpha check via a cheap sampled scan.

3. **Format convert** — output as JPEG / WebP / PNG / keep original.
4. **Strip metadata** — free side effect: canvas re-encode drops EXIF/GPS by definition. Surface it as an explicit (informational) recipe step so users know it happens.
5. **Rename** — pattern with tokens: `{name}`, `{index}`, `{width}x{height}`, `{date}`.

**Email preset button:** longest edge 1600 px → total budget 20 MB → JPEG. One click for the common case.

## 5. Processing Pipeline

- Concurrency pool (3–4 workers) rather than all-at-once: decoding a 48 MP photo can take >100 MB of RAM as bitmap; unbounded parallelism on a 200-photo folder kills the tab.
- Where supported, do the work in a **Web Worker** with `OffscreenCanvas` (`convertToBlob`) so the UI never jangs. Fallback: main-thread canvas with `await`-yields between files.
- `bitmap.close()` and `URL.revokeObjectURL()` aggressively after each file.
- Per-file failures (corrupt file, unsupported format) are logged and skipped — never abort the batch.
- Progress: overall bar + running totals ("142 MB → 18.3 MB").

## 6. Output

- **ZIP download** via JSZip (`STORE` compression — images don't deflate, save the CPU), preserving folder structure.
- **Individual downloads** for small batches (anchor + object URL per file).
- Results table: per-file before/after size, dimensions, % saved; click for side-by-side preview at 100% crop (quality sanity check).

## 7. UI Sketch

```
┌──────────────────────────────────────────────┐
│  ImageChef                                   │
├───────────────┬──────────────────────────────┤
│  RECIPE       │  ⬇ Drop folder / images here │
│  ┌─────────┐  │  ┌────────────────────────┐  │
│  │ Resize  │  │  │ file list + thumbnails │  │
│  │ ≤1600px │  │  │ name  size  →  status  │  │
│  ├─────────┤  │  └────────────────────────┘  │
│  │ Compress│  │  [████████░░] 34/120         │
│  │ Σ ≤20MB │  │  142 MB → 18.3 MB            │
│  └─────────┘  │                              │
│  [Email preset]  [▶ Bake]   [⬇ Download ZIP] │
└───────────────┴──────────────────────────────┘
```

Plain CSS, no framework — vanilla JS + `<template>` elements keeps the single file small (~30–50 KB before CDN deps) and auditable.

## 8. Edge Cases & Risks

- **Color profiles:** canvas re-encode flattens to sRGB; wide-gamut (Display P3) photos shift slightly. Acceptable for email; note it.
- **Animated GIF/WebP:** v1 takes first frame only; label clearly.
- **Very large images:** browsers cap canvas dimensions (~16k px / ~268 MP area in Chrome, lower in Safari). Detect and pre-scale during decode (`createImageBitmap` accepts `resizeWidth/Height`).
- **Safari quirks:** `OffscreenCanvas.convertToBlob` and `webkitdirectory` support are fine in current versions, but feature-detect and fall back.
- **toBlob quality ignored for PNG** — hence the convert-to-lossy logic above.

## 9. Deployment

- Pages: drop `index.html` in repo root, done.
- Workers: static asset binding, or inline the HTML as a template string returned with `Content-Type: text/html` — either works since it's one file.
- CSP header (via `_headers` on Pages): `script-src 'self' cdnjs.cloudflare.com` + SRI on the JSZip tag.

## 10. Roadmap (post-v1)

Crop/pad to aspect ratio · watermark overlay · rotate/flip op · AVIF output (encode support now broad) · recipe-in-URL sharing · PWA/offline.
