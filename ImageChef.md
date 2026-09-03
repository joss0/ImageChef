# ImageChef

A single-file, browser-only, batch image processor. You tune a recipe once, on one
image, with instruments good enough to trust. Then you feed it hundreds of images,
forever, and it does the same thing every time.

## What it is not

- Not an editor. No human looks at individual images during a batch run.
- Not per-image. Every operation is a deterministic function of
  `(image, recipe, batch position, dates of record)`. If a feature requires a
  human to look at a specific image and decide something, it does not belong
  here. A date of record — the image's own capture date, the day the batch was
  run — is data the user asks for by name, not a per-image decision.
- Not ordered. There is no operation list to arrange. There is no drag-to-reorder.

These exclusions are load-bearing. They are what makes the output trustable.

## Explicit non-features (decided, not forgotten)

| Feature | Why excluded |
|---|---|
| Crop | Requires looking at each image; not generalizable across a batch. |
| Redaction | Inherently per-image judgment. Belongs in a separate one-image-at-a-time tool. |
| Per-image data manifest (CSV in) | Turns the tool into an interactive editor with a batch veneer. |
| User-ordered operation list | Every real ordering sensitivity has a better resolution (see below). |
| Percent resize | Relative to each image's own size; not a fixed recipe. Name a box instead. |
| Total-batch byte budget | Divides a number by however many files showed up; not per-image. Cap per image. |
| "Keep original" output format | Varies per image. A recipe names its format. |

## The recipe is a record, not a list

A recipe is a JSON object with optional fields ("slots"). Each slot appears at most
once. Two recipes with the same fields are the same recipe — recipes are diffable,
shareable, and order-insensitive by construction.

The engine executes slots in one fixed internal pipeline:

```
decode → orient → resize → sharpen → stamp → flatten → color → metadata → encode
```

Exactly one decode. Exactly one encode, at the end. Generational loss is impossible
by construction, not by user discipline.

Three slots act on the *set* rather than on pixels and sit outside the pipeline:
`dedup` decides which files are processed at all, `output` names each encoded
result, and `manifest` describes the run. They are still functions of
`(input set, recipe)` and nothing else.

### The recipe lives in the URL

There is no save button. Whatever Calibrate currently shows *is* the recipe, and
it is mirrored into the page's URL fragment as it changes. A bookmark is a saved
recipe; a copied link is a shared one; opening either restores every control.
The rework's explicit "save, then process" step was a gate the user paid for
and the tool did not need.

### The default recipe

An empty record is a valid recipe and a poor first impression. A fresh page
starts from the email preset — fit inside 2048 px, JPEG under 100 KB on a white
background, exact duplicates skipped — so the first Process run does something
sensible. Every slot stays optional.

### Dates of record

`{date}` is the image's own date: its EXIF capture date, else the file's
modification date. `{today}` is the day the batch was run. Neither is the day the
recipe was saved — a copyright line wants the year the picture was taken, and an
archive wants the day it was made. A recipe that uses `{today}` is deterministic
per day, and says so by using the token. Nothing else in the engine reads the
clock.

### Why no user ordering is needed

Every apparent ordering problem collapses into one of three shapes:

1. **Closed group.** Rotate and mirror don't commute, but all their compositions
   form the dihedral group D4 — the same 8 states as EXIF orientation. Store one
   orientation *state*, not a sequence of orientation *operations*.
2. **Frame of reference.** Geometry parameters are defined in post-orientation
   source space. Once the frame is fixed by definition, specification order is
   meaningless.
3. **Unique correct position.** Sharpen goes after resample (sharpening before a
   downscale is destroyed by the resample). Stamp is rendered in output space just
   before flatten. There is no legitimate alternative, so the engine owns the
   position and the user never sees a choice.

## The slots

| Slot | Value | Notes |
|---|---|---|
| `orient` | one of 8 D4 states | UI: successive rotate/flip taps compose into the state |
| `resize` | `{ intent, dimensions, upscale? }` | Intents: `fit`, `cover`, `exact-pad`. Named intents, not user-assembled compositions. `fit` never enlarges a smaller source unless `upscale: true`. Resample in linear light with premultiplied alpha. |
| `sharpen` | amount | Applied immediately after resample. |
| `stamp` | template + position + style | Tokens (shared with `output`): `{name}`, `{seq}` / `{seq:N}`, `{date}`, `{today}`, `{hash:N}`, `{width}`, `{height}`. One mechanism covers serial-numbering, copyright lines, and DRAFT marks. |
| `flatten` | background color | Alpha handling is explicit, not incidental. |
| `color` | target profile (sRGB) | Convert, then tag or strip the profile per `metadata`. |
| `metadata` | retain-list | Default strip-all; the user names what survives (e.g. copyright). |
| `encode` | `{ format, constraints }` | Constraints below. |
| `output` | file-name template + zip-name template | Same tokens as `stamp`, resolved per image; the encode format supplies the extension. Defaults `{name}` and `imagechef-{today}`. Set-level — it names the encoded result. |
| `dedup` | `{ by: "name+size" \| "name" }` | Later files matching an earlier one are skipped, listed as "Duplicate of …" in the results, and never numbered by `{seq}`. Set-level; default on (`name+size`). |
| `manifest` | boolean | Emit `manifest.json` in the zip: filenames, dimensions, bytes, hashes, the recipe itself, date. Provenance for free. |

## Encoding is constraint satisfaction, not a quality slider

The `encode` slot declares constraints, e.g. `{ maxBytes: 400000, format: "jpeg" }`,
optionally with a **perceptual floor**.

### Calibration

You tune on one exemplar image. What gets stored is not the quality number you
landed on — it is the **perceptual score you achieved** (SSIM against the
pre-encode raster). Each image in the batch then binary-searches encoder quality to
hit that same perceptual score. q=80 means different things for fog and for line
art; a perceptual target transfers, a quality number doesn't.

### Unsatisfiable constraints are a first-class result

`maxBytes` and a perceptual floor can conflict. Detect it at search exhaustion and
report it per image: "3 images cannot meet 400KB without dropping below your
perceptual floor." This is an error class the tool can *name*, because no step is
at fault — the declaration is.

## Inspection: show the delta in its native domain

Step thumbnails are dishonest: downscaling destroys exactly the information
(artifacts, ringing, subsampling damage) that compression manipulates, and metadata
removal is invisible at any scale. Each slot renders what it *changed*:

| Slot | Delta view |
|---|---|
| `orient` | orientation glyph |
| `resize` | before/after dimensions; a thumbnail is honest here — the only place it is |
| `metadata` | text diff table: removed rows struck through, retained rows shown |
| `encode` | bytes before/after, achieved quality, achieved SSIM, and the worst-region loupe |

### The worst-region loupe

At encode time both rasters are in memory. Compute per-8×8-block error (SAD is
sufficient) between the pre-encode raster and the decoded post-encode result. Show
a 1:1 crop of the highest-error tile, before/after, with a flicker toggle. The tool
finds where the compression hurts most and takes you there. Nobody can judge q=78
vs q=82 from a thumbnail; everyone can judge the worst 128×128 patch at 100% with
an A/B flicker.

## Modes

| Mode | Recipe supplies | What happens |
|---|---|---|
| **Audit** | nothing (read-only) | Report table across the set: dimensions, format, color profile, metadata inventory, GPS/PII exposure. No pixels touched. |
| **Calibrate** | operations, tuned live | One exemplar, full instruments. The recipe is whatever Calibrate shows, mirrored into the URL as it changes (including the perceptual target). |
| **Process** | everything | The batch run over the current recipe, several images in flight. Deterministic: output never depends on which finished first. Zip out, optional manifest. |

Audit and the manifest share one report generator: audit is the report *instead of*
processing; the manifest is the same report *attached to* processing.

## Platform constraints (unchanged)

- Single HTML file, vanilla JS, no build step, no framework.
- Hosted on Cloudflare Pages. No server, no accounts, no telemetry.
- Zip via fflate (the one permitted dependency, vendored inline).
- Everything runs locally in the browser; images never leave the machine.
