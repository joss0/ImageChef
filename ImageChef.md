# ImageChef

A single-file, browser-only, batch image processor. You tune a recipe once, on one
image, with instruments good enough to trust. Then you feed it hundreds of images,
forever, and it does the same thing every time.

## What it is not

- Not an editor. No human looks at individual images during a batch run.
- Not per-image. Every operation is a deterministic function of
  `(image, recipe, batch position)`. If a feature requires a human to look at a
  specific image and decide something, it does not belong here.
- Not ordered. There is no operation list to arrange. There is no drag-to-reorder.

These exclusions are load-bearing. They are what makes the output trustable.

## Explicit non-features (decided, not forgotten)

| Feature | Why excluded |
|---|---|
| Crop | Requires looking at each image; not generalizable across a batch. |
| Redaction | Inherently per-image judgment. Belongs in a separate one-image-at-a-time tool. |
| Per-image data manifest (CSV in) | Turns the tool into an interactive editor with a batch veneer. |
| User-ordered operation list | Every real ordering sensitivity has a better resolution (see below). |

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
| `resize` | `{ intent, dimensions }` | Intents: `fit`, `cover`, `exact-pad`. Named intents, not user-assembled compositions. Resample in linear light with premultiplied alpha. |
| `sharpen` | amount | Applied immediately after resample. |
| `stamp` | template + position + style | Variables: `{date}`, `{seq}`, `{name}`, `{hash:8}`. One mechanism covers serial-numbering, copyright lines, and DRAFT marks. |
| `flatten` | background color | Alpha handling is explicit, not incidental. |
| `color` | target profile (sRGB) | Convert, then tag or strip the profile per `metadata`. |
| `metadata` | retain-list | Default strip-all; the user names what survives (e.g. copyright). |
| `encode` | `{ format, constraints }` | Constraints below. |
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
| **Calibrate** | operations, tuned live | One exemplar, full instruments, produces the recipe (including the perceptual target). |
| **Process** | everything | The batch run. Deterministic. Zip out, optional manifest. |

Audit and the manifest share one report generator: audit is the report *instead of*
processing; the manifest is the same report *attached to* processing.

## Platform constraints (unchanged)

- Single HTML file, vanilla JS, no build step, no framework.
- Hosted on Cloudflare Pages. No server, no accounts, no telemetry.
- Zip via fflate (the one permitted dependency, vendored inline).
- Everything runs locally in the browser; images never leave the machine.
