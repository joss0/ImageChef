# 🍳 ImageChef

**Client-side batch image processor — nothing leaves your browser.**

ImageChef turns a batch of images into a trustworthy, deterministic pipeline
run: tune a recipe once on one exemplar image, then apply it unchanged to
hundreds of images. No server, no uploads, no accounts.

Read [`ImageChef.md`](./ImageChef.md) for what the tool is (and deliberately
is not), and [`ImageChef-design-brief.md`](./ImageChef-design-brief.md) for
the implementation spec and acceptance tests. This README is the practical
summary; those two are the source of truth.

## The model

A recipe is a **record**, not a list — up to nine named, optional fields
(`orient`, `resize`, `sharpen`, `stamp`, `flatten`, `color`, `metadata`,
`encode`, `manifest`). There is no operation list, no drag-to-reorder, no
per-op enable toggle. The engine runs one fixed pipeline:

```
decode → orient → resize → sharpen → stamp → flatten → color → metadata → encode
```

Two recipes with the same fields in a different key order are the same
recipe, because the engine reads each slot by name rather than iterating
over whatever order the fields happen to be in.

## Modes

- **Audit** — reads every loaded file's dimensions, format, color-profile
  signal, and metadata inventory (flagging GPS/PII). No pixels are modified.
- **Calibrate** — pick one exemplar image, tune every slot with full
  instruments (worst-region loupe, metadata diff table, before/after resize
  thumbnail), and produce the recipe. The encode slot's "quality" control
  is a calibration instrument only — what gets saved is the **achieved SSIM**
  against the pre-encode raster, not the quality number.
- **Process** — runs the saved recipe over the whole batch. Each image
  binary-searches encoder quality to hit the calibrated SSIM target subject
  to an optional byte cap; a conflict between the two is reported by name,
  not silently resolved, and the run continues for the rest of the batch.
  Output is a ZIP (optionally with a `manifest.json` built by the same report
  generator Audit uses).

## Notable behavior

- **Orientation** is one of 8 states (the D4 group — same as EXIF
  orientation), composed from the image's own EXIF tag and any rotate/flip
  taps during calibration into a single transform applied once.
- **Resize** intents are `fit`, `cover`, and `exact-pad` — named, not
  user-assembled compose-your-own scale+crop. Resampling happens in linear
  light on premultiplied alpha, so a transparent neighbor never drags an
  opaque edge toward black.
- **Metadata** defaults to strip-all, including the color-space tag the
  browser's own encoder embeds regardless of what was asked for. Retaining
  copyright/artist/description/capture-date is opt-in and by name; GPS is
  never retainable through this mechanism, even opt-in.
- **Determinism**: the same input set and recipe produce a byte-identical
  ZIP on repeat runs — `{date}` and `{hash:8}` stamp tokens are frozen at
  Save Recipe / read from file content, never wall-clock at Process time.
- **Image Inspector**: a zoom/pan viewer for eyeballing full images, not just
  the worst-region loupe's crop — click a file's thumbnail at import time, or
  "View original vs final" during Calibrate, or "Inspect" on a Process
  result. The comparison is always the source file as imported against the
  actual fully-processed result, never an intermediate pipeline step. Where
  loss is known (every block's error, not just the single worst one), it's
  marked on the final image as a normalized heatmap that breathes and
  periodically shines, so the lossy regions are findable before you zoom in.

## Supported input formats

JPEG, PNG, WebP, BMP, GIF (first frame), and ZIP archives of the above.

## Usage

1. Open `index.html` in any modern browser — no install, no build step.
2. Drop images, a folder, or a ZIP archive onto the drop zone.
3. **Audit** the set, or go straight to **Calibrate**: pick an exemplar,
   tune the slots you need, click **Save Recipe**.
4. In **Process**, click **Run Batch**, then **Download ZIP**.

## Architecture

Single self-contained `index.html` — all CSS and JavaScript inline, no
build step, no framework. One dependency:

- [fflate](https://github.com/101arrowz/fflate) (MIT) — ZIP read/write,
  vendored inline. Nothing is fetched over the network at runtime.

All image processing uses native browser APIs (`createImageBitmap`, canvas,
`canvas.toBlob`) plus a from-scratch linear-light premultiplied resampler
and a block-based SSIM/SAD implementation (not a full reference SSIM —
non-overlapping 8×8 blocks, the same granularity the worst-region loupe
uses).

**Privacy:** images never leave the device. There is no backend.

### Known scope cuts (deliberate, not oversights)

- **HEIC/HEIF input** was dropped along with it — supporting it previously
  required a second CDN-loaded dependency (`heic2any`), which conflicts with
  "fflate is the one permitted dependency."
- **WebP metadata retention** isn't implemented — RIFF chunk surgery for
  WebP's metadata layout was judged not worth the complexity given JPEG and
  PNG cover the common cases. WebP output always strips metadata.
- **Full ICC profile embedding** is out of scope. The `color` slot's job is
  reduced to: confirm/record sRGB output and decide whether to strip the
  color-space tag the browser encoder adds on its own. It does not embed a
  custom ICC profile blob.
- **GPS is never retainable** via the metadata slot, even opt-in — Audit
  still flags its presence on source files, but the retain-list can't be
  used to carry location data into output.

## Tests

```
npm test
```

Runs `node --test` over `tests/*.test.mjs`. The DOM-free engine internals
(D4 orientation composition, recipe canonicalization, the linear-premultiplied
resampler, block SSIM/SAD, the minimal EXIF/PNG metadata writers) are
extracted straight out of `index.html` between `ENGINE-LIB` / `JPEG-META-LIB`
sentinel comments and unit-tested directly, so the shipped code is what's
under test.

## Deployment

Drop `index.html` anywhere that serves static files:

- **Cloudflare Pages** — push to a repo, done.
- **Any static host** — single file, no dependencies to install.
- **Locally** — open the file directly in a browser. `file://` works for
  most features; folder drag-and-drop may require a server origin in some
  browsers.

## Browser support

Any modern browser with `createImageBitmap` support (Chrome 69+, Firefox
105+, Safari 16.4+). `crypto.subtle` (used for the `{hash:8}` stamp token
and manifest content hashes) requires a secure context — `https://` or
`localhost`; some `file://` origins may not provide it.
