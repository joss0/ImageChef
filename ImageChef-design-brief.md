# The Little ImageChef

*A design brief for the coding agent, in the style it deserves: short questions,
short answers, and commandments that are checked, not admired.*

Read `ImageChef.md` first. This document tells you what to build and how to know
you built it.

---

## Chapter 1: The Recipe

Is a recipe a list of operations?
> No. It is a record with optional slots.

May a slot appear twice?
> It cannot. A record's field has one value.

Do two recipes with the same fields in different order differ?
> No. `JSON.stringify` of a canonically-ordered recipe is its identity.

What are the slots?
> `orient`, `resize`, `sharpen`, `stamp`, `flatten`, `color`, `metadata`,
> `encode`, `output`, `manifest`.

Does the user choose the execution order?
> Never. The engine runs one fixed pipeline:
> `decode → orient → resize → sharpen → stamp → flatten → color → metadata → encode`.

How many times is an image decoded?
> Once.

How many times is an image encoded?
> Once, at the end. If you find yourself encoding in the middle, stop.
> You are about to reintroduce the generational-loss bug class.

---

## Chapter 2: Orientation

How is rotation stored?
> As one of the 8 states of D4 — identity, three rotations, and four reflections.
> The same 8 states as EXIF orientation.

The user taps rotate, then flip, then rotate. What is stored?
> One state. Composition happens in the UI; the recipe holds only the result.

What happens to the source file's EXIF orientation tag?
> It is composed into the state at decode. After decode, pixels are upright and
> the tag is dead. Never carry the tag forward.

---

## Chapter 3: Resize

What are the resize intents?
> `fit` (inside a box, aspect preserved), `cover` (fill a box, aspect preserved,
> center-trimmed), `exact-pad` (exact dimensions, padded with the flatten color).

May the user compose scale-then-trim manually?
> No. Composition is ordering-reasoning in disguise. Name the intent instead.

In what light is resampling done?
> Linear light, with premultiplied alpha. sRGB-space averaging of unassociated
> alpha is the bug we already fixed once. Do not fix it a second time.

Where does sharpen go?
> Immediately after resample. Nowhere else. The user does not place it.

---

## Chapter 4: The Stamp and the Name

What is a stamp?
> A template string rendered at a fixed position in output space.

What tokens exist?
> `{name}`, `{seq}` / `{seq:N}`, `{date}`, `{today}`, `{hash:N}`, `{width}`,
> `{height}`. One vocabulary for the stamp and the output name. Do not build two.

What is `{date}`?
> The image's date of record: its EXIF capture date, else its file's
> modification date. Never the recipe's save date — a copyright line wants the
> year the picture was taken.

What is `{today}`?
> The day the batch was run. A recipe that uses it is deterministic per day,
> and declares as much by using the token.

Is `{seq}` deterministic?
> Yes: it is the image's index in the sorted (by filename) input set.
> The same input set stamps the same numbers every run.

Is the stamp a watermark, a serial number, or a DRAFT mark?
> Yes. One mechanism. Do not build three.

What does the `output` slot hold?
> A file-name template and a zip-name template. The encode format supplies
> the extension; the template never does. Illegal filename characters are
> stripped from the resolved name, not from the template, so `{seq:3}` keeps
> its colon.

Two images resolve to the same name. What happens?
> The later one, in batch order, gets `-2`, then `-3`. A collision is a
> suffix, never an overwrite and never a question.

May the user name each image from a pasted table?
> No. That is the CSV-in non-feature. A name is a function of
> `(image, recipe, batch position, dates of record)`, same as the pixels.

---

## Chapter 5: Encoding

What does the `encode` slot hold?
> A format and constraints: `maxBytes`, and optionally a perceptual target
> (SSIM against the pre-encode raster).

What does calibration store — the quality slider value?
> No. The achieved SSIM. Quality numbers do not transfer between images;
> perceptual scores do.

How does each batch image meet the target?
> Binary search over encoder quality until achieved SSIM meets the target,
> subject to `maxBytes`.

What if `maxBytes` and the perceptual floor cannot both be met?
> That is a result, not an exception. Report it per image, by name, in the
> summary: "cannot meet 400KB without dropping below your floor."
> Never silently pick a side.

---

## Chapter 6: Inspection

Does each slot get a thumbnail?
> No. Each slot shows its delta in its native domain.

What does the metadata slot show?
> A diff table: removed rows struck through, retained rows shown.

What does the encode slot show?
> Bytes before/after, achieved SSIM, and the worst-region loupe.

What is the worst-region loupe?
> Per-8×8-block SAD between pre-encode and decoded post-encode rasters.
> Show the highest-error tile at 1:1, before/after, with a flicker toggle.

Where is the only honest thumbnail?
> The resize slot.

---

## Chapter 7: Modes

What are the modes?
> Audit (read the set, touch nothing), Calibrate (one exemplar, full
> instruments, produces the recipe), Process (the batch run, zip out).

Do Audit and the manifest share code?
> They must. One report generator, two exits: instead-of-processing, or
> attached-to-processing as `manifest.json` in the zip.

---

## The Ten Commandments

1. **Decode once. Encode once.** No intermediate encodes, ever.
2. **The recipe is a record.** No lists of operations, no ordering UI,
   no reorder affordances anywhere in the DOM.
3. **One file.** Single HTML file, vanilla JS, no build step, no framework.
   fflate vendored inline is the only dependency.
4. **Nothing leaves the browser.** No network requests during processing.
   Verify with the network tab open.
5. **Resample in linear light with premultiplied alpha.**
6. **Default strip-all metadata.** Retention is opt-in, by named field.
7. **Determinism is the product; dates of record are data.** Same inputs +
   same recipe = the same pixels, the same bytes, the same names. A date of
   record — the image's own capture date, or the day the batch was run — is
   an input the user asked for by name (`{date}`, `{today}`), not noise: it
   may appear in a stamp, a filename, or the manifest, and nowhere else.
   Never read the clock for anything a token did not request. This is a
   test, not an aspiration.
8. **Unsatisfiable is a report, not a crash.** Constraint failures are named,
   per image, in the summary.
9. **Show deltas in their native domain.** No step thumbnails except resize.
10. **When a feature needs a human to look at one specific image, refuse it.**
    That is the boundary of the tool.

## Acceptance tests

- Two recipes with identical fields serialized in different key orders produce
  identical output zips.
- A PNG with unassociated alpha, downscaled 4×, shows no dark fringing at
  opaque/transparent edges.
- A batch containing one foggy photo and one line-art PNG, calibrated to
  SSIM 0.97, produces different quality values per image and both meet the target.
- An image whose `maxBytes` conflicts with the floor appears by name in the
  results summary with the conflict stated; the run completes for the others.
- Audit mode on a set containing GPS EXIF flags the exposure without modifying
  any file.
- Running the same input set twice produces byte-identical image entries under
  identical names; a recipe using `{today}` differs only in that token, and
  only across days.
- An `output.name` of `{date}_{seq:3}` over two images captured on the same day
  yields `…_001` and `…_002`; two that resolve identically yield `x` and `x-2`,
  never one file.
- Rotating 90° four times in the UI stores the identity orientation.
- The output JPEG of a `metadata: retain [copyright]` recipe contains the
  copyright field and nothing else when inspected with an EXIF reader.

Are we done?
> When the tests pass and the file is still one file, yes.
