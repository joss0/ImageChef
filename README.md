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

A recipe is a **record**, not a list — up to eleven named, optional fields
(`orient`, `resize`, `sharpen`, `stamp`, `flatten`, `color`, `metadata`,
`encode`, `output`, `dedup`, `manifest`). There is no operation list, no drag-to-reorder, no
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
- **Calibrate** — pick one exemplar image and tune every slot with full
  instruments (worst-region loupe, metadata diff table, before/after resize
  thumbnail). What Calibrate shows *is* the recipe; it is mirrored into the
  page URL as you edit, so there is no save step. The encode slot's
  "quality" control is a calibration instrument only — what the recipe
  carries is the **achieved SSIM** against the pre-encode raster, not the
  quality number. A fresh page starts from the **email preset** (fit inside
  1600 px, JPEG under 800 KB, white background, exact duplicates skipped);
  "Reset to email default" returns to it.
- **Process** — runs the current recipe over the whole batch. Each image
  binary-searches encoder quality to hit the calibrated SSIM target subject
  to an optional byte cap; a conflict between the two is reported by name,
  not silently resolved, and the run continues for the rest of the batch.
  Images are processed three at a time; output names, collision suffixes,
  the results table and the ZIP entries are assigned in file order once
  the pool drains, so parallelism changes the wall clock, never the output.
  Output is a ZIP (optionally with a `manifest.json` built by the same report
  generator Audit uses). Because the recipe lives in the URL, a bookmark or
  copied link is a saved recipe: open it and you land straight on Process
  with every Calibrate control already set — drop images, Run Batch, review,
  download, or step back into Calibrate to adjust.

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
- **Output names are templated.** The `output` slot holds a file-name
  template (default `{name}`; the encode format supplies the extension) and
  a ZIP-name template (default `imagechef-{today}`). Both share the stamp's
  token vocabulary: `{name}`, `{seq}` / `{seq:3}` (zero-padded batch
  position), `{date}`, `{today}`, `{hash:8}`, `{width}x{height}`; the ZIP
  name also takes `{count}` (files processed; `{created}` is kept as an
  alias for `{today}`). Illegal filename characters
  are stripped from the resolved name, and two images that resolve to the
  same name get `-2`, `-3` rather than overwriting each other. Calibrate
  shows the exemplar's resolved name live.
- **Determinism, with dates of record**: the same input set and recipe
  produce byte-identical image entries under identical names on repeat
  runs. Dates are data, not noise: `{date}` is the image's own EXIF capture
  date (else its file date) and `{today}` is the run date, so a copyright
  stamp or an archive name gets a real date. `{hash:N}` is read from file
  content. Nothing else reads the clock.
- **Remove Duplicates** is the `dedup` slot: match later files to earlier
  ones by name+size (default) or by name only. Nothing is dropped at
  import — every file is listed, duplicates are badged in the file list
  as the setting changes, skipped at Process time, shown as "Duplicate of
  …" in the results, and never given a `{seq}` number.
- **Image Inspector**: a zoom/pan viewer for eyeballing full images, not just
  the worst-region loupe's crop — click a file's thumbnail at import time, or
  "View original vs final" during Calibrate, or "Inspect" on a Process
  result. The comparison is always the source file as imported against the
  actual fully-processed result, never an intermediate pipeline step. Where
  loss is known (every block's error, not just the single worst one), it's
  marked on the final image as a normalized heatmap, power-law biased so
  ordinary moderate loss doesn't wash the image in tint — only the
  genuinely worst regions stay strongly marked. The unaffected image is
  what you see almost all the time; the mask only flashes on for about
  half a second every three seconds, so it's findable without being a
  standing distraction.
- **Exemplar selection**: clicking a file in the left-hand list (its
  thumbnail included) sets it as the Calibrate exemplar, kept in sync with
  the "Tune on" dropdown — no need to hunt for it by name in a list.
- **Old recipe bookmarks still work.** A link saved under the pre-rework,
  CyberChef-style ordered op list (see `imagechef-outline.md`) is detected
  and migrated (both the old `#r=` and the current `#recipe=` hash keys, and
  both the bare-array and the wrapped payload the old build wrote):
  rotate/flip, a fixed-size or longest-edge resize, a per-image byte cap,
  jpeg/png/webp format, the rename pattern (into `output.name`, with
  `{index}` becoming `{seq:3}`) and the ZIP name (into `output.zip`) all
  carry over. What has no equivalent in the fixed pipeline — a percent
  resize (relative to each image, not a fixed box), a total-batch byte
  budget, "keep original" format, grayscale — is named in an on-screen
  notice rather than silently dropped or guessed at.

## Supported input formats

JPEG, PNG, WebP, BMP, GIF (first frame), and ZIP archives of the above.

## Usage

1. Open `index.html` in any modern browser — no install, no build step.
2. Drop images, a folder, or a ZIP archive onto the drop zone.
3. **Audit** the set, or go straight to **Calibrate**: pick an exemplar and
   tune the slots you need — the URL follows along, so bookmark it if you
   want the recipe back later.
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
