// Unit tests for ImageChef's DOM-free engine library (recipe canonicalization,
// D4 orientation composition, linear-premultiplied resampling, block SSIM/SAD,
// and the minimal metadata writers). The helpers live inside the single-file
// app (index.html), delimited by the ENGINE-LIB sentinels; we extract that
// block and evaluate it here so the shipped code is what's under test.
//
// Run with:  node --test   (or  npm test )

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const block = html.match(/\/\/ ===== ENGINE-LIB-START =====([\s\S]*?)\/\/ ===== ENGINE-LIB-END =====/);
assert.ok(block, 'ENGINE-LIB block not found in index.html');

const lib = new Function(block[1] + `
  return {
    canonicalRecipe, recipeIdentity, SLOT_KEYS, recipeToHash, recipeFromHash, migrateLegacyRecipe, DEFAULT_RECIPE,
    resolveTemplate, sanitizeFilename, resolveOutputBasename, uniqueName, DEFAULT_OUTPUT_NAME, DEFAULT_ZIP_NAME,
    partitionDuplicates,
    ORIENT_STATES, ORIENT_TAP, ORIENT_IDENTITY, composeOrientStates,
    resampleAxis, resampleLinearPremultiplied,
    computeBlockStats, normalizeBlockLoss,
    injectPngText, readPngText, stripPngColorChunks,
    writeMinimalJpegExif, injectJpegMinimalExif,
  };
`)();

const {
  canonicalRecipe, recipeIdentity, SLOT_KEYS, recipeToHash, recipeFromHash, migrateLegacyRecipe, DEFAULT_RECIPE,
  resolveTemplate, sanitizeFilename, resolveOutputBasename, uniqueName, DEFAULT_OUTPUT_NAME, DEFAULT_ZIP_NAME,
  partitionDuplicates,
  ORIENT_TAP, ORIENT_IDENTITY, composeOrientStates,
  resampleLinearPremultiplied,
  computeBlockStats, normalizeBlockLoss,
  injectPngText, readPngText, stripPngColorChunks,
  writeMinimalJpegExif, injectJpegMinimalExif,
} = lib;

// ── Recipe is a record: key order never affects identity ─────────────────
test('canonicalRecipe produces identical JSON regardless of input key order', () => {
  const a = { encode: { format: 'jpeg', maxBytes: 400000 }, orient: 3, resize: { intent: 'fit', dimensions: { width: 800, height: 600 } } };
  const b = { resize: { intent: 'fit', dimensions: { width: 800, height: 600 } }, orient: 3, encode: { format: 'jpeg', maxBytes: 400000 } };
  assert.equal(recipeIdentity(a), recipeIdentity(b));
});

test('canonicalRecipe drops unknown keys and keeps createdDate', () => {
  const r = { bogus: 1, orient: 0, createdDate: '2026-07-13' };
  const c = canonicalRecipe(r);
  assert.deepEqual(c, { orient: 0, createdDate: '2026-07-13' });
});

// ── DEFAULT_RECIPE: the email preset a fresh page starts from ────────────
test('DEFAULT_RECIPE is already canonical, in SLOT_KEYS order', () => {
  const c = canonicalRecipe(DEFAULT_RECIPE);
  assert.deepEqual(c, DEFAULT_RECIPE);
  assert.deepEqual(Object.keys(c), SLOT_KEYS.filter(k => DEFAULT_RECIPE[k] !== undefined));
});

test('DEFAULT_RECIPE carries exactly orient, resize, flatten, encode, dedup', () => {
  assert.deepEqual(Object.keys(DEFAULT_RECIPE).sort(), ['dedup', 'encode', 'flatten', 'orient', 'resize'].sort());
});

test('DEFAULT_RECIPE round-trips through recipeToHash/recipeFromHash', () => {
  const result = recipeFromHash(recipeToHash(DEFAULT_RECIPE));
  assert.equal(result.legacy, false);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.recipe, canonicalRecipe(DEFAULT_RECIPE));
});

test('DEFAULT_RECIPE is frozen', () => {
  assert.equal(Object.isFrozen(DEFAULT_RECIPE), true);
});

// ── Recipe <-> URL hash: a saved recipe is bookmarkable ───────────────────
test('recipeToHash / recipeFromHash round-trip a recipe unchanged', () => {
  const recipe = {
    orient: 5,
    resize: { intent: 'fit', dimensions: { width: 1920, height: 1080 } },
    encode: { format: 'jpeg', ssimTarget: 0.987, maxBytes: 400000 },
    createdDate: '2026-09-01',
  };
  const hash = recipeToHash(recipe);
  assert.match(hash, /^#recipe=/);
  const result = recipeFromHash(hash);
  assert.equal(result.legacy, false);
  assert.deepEqual(result.notes, []);
  assert.deepEqual(result.recipe, canonicalRecipe(recipe));
});

test('recipeToHash / recipeFromHash round-trip non-ASCII stamp text', () => {
  const recipe = { stamp: { template: '© 2026 — café ★', position: 'br', style: {} } };
  const hash = recipeToHash(recipe);
  assert.deepEqual(recipeFromHash(hash).recipe, canonicalRecipe(recipe));
});

test('recipeFromHash drops unknown keys, same as canonicalRecipe', () => {
  const hash = recipeToHash({ orient: 2, bogus: 'nope' });
  assert.deepEqual(recipeFromHash(hash).recipe, { orient: 2 });
});

test('recipeFromHash returns null for a missing, malformed, or tampered hash', () => {
  assert.equal(recipeFromHash(''), null);
  assert.equal(recipeFromHash('#recipe='), null);
  assert.equal(recipeFromHash('#recipe=not-valid-base64!!!'), null);
  assert.equal(recipeFromHash('#somethingElse=abc'), null);
  assert.equal(recipeFromHash(undefined), null);
});

// ── Legacy (pre-rework, ordered op-list) recipes: migrate, never vanish ───
// Fixture mirrors the old app's own defaultRecipe(): resize, compress,
// format, strip, rename, all enabled — see old-index.html (git history,
// pre "Rework ImageChef..." commit) for the original op shapes.
function legacyStep(op, config, enabled = true) {
  return { uid: 'x', op, enabled, config };
}

test('migrateLegacyRecipe maps the old default recipe onto today\'s slots', () => {
  const legacy = [
    legacyStep('resize', { mode: 'fit', w: 1920, h: 1080, percent: 75, longest: 1600 }),
    legacyStep('compress', { mode: 'per', perKB: 500, totalMB: 20 }),
    legacyStep('format', { output: 'jpeg' }),
    legacyStep('strip', {}),
    legacyStep('rename', { pattern: '{name}' }),
  ];
  const { recipe, notes } = migrateLegacyRecipe(legacy);
  assert.deepEqual(recipe.resize, { intent: 'fit', dimensions: { width: 1920, height: 1080 } });
  assert.equal(recipe.encode.maxBytes, 500 * 1024);
  assert.equal(recipe.encode.format, 'jpeg');
  assert.equal(recipe.orient, undefined); // no rotate step present
  // The rename pattern lives on as the output slot's name template, so the
  // old default recipe migrates with nothing to report.
  assert.deepEqual(recipe.output, { name: '{name}' });
  assert.deepEqual(notes, []);
});

test('migrateLegacyRecipe: rename tokens map onto today\'s — {index} was 3-digit padded, so it becomes {seq:3}', () => {
  const { recipe, notes } = migrateLegacyRecipe([legacyStep('rename', { pattern: '{date}_{name}_{index}_{width}x{height}' })]);
  assert.equal(recipe.output.name, '{date}_{name}_{seq:3}_{width}x{height}');
  assert.deepEqual(notes, []);
});

test('migrateLegacyRecipe: old "exact" resize mode did the same aspect-fit math as "fit"', () => {
  const { recipe } = migrateLegacyRecipe([legacyStep('resize', { mode: 'exact', w: 800, h: 600 })]);
  assert.deepEqual(recipe.resize, { intent: 'fit', dimensions: { width: 800, height: 600 } });
});

test('migrateLegacyRecipe: "longest edge" becomes a fit into a same-side square box', () => {
  const { recipe } = migrateLegacyRecipe([legacyStep('resize', { mode: 'longest', longest: 1600 })]);
  assert.deepEqual(recipe.resize, { intent: 'fit', dimensions: { width: 1600, height: 1600 } });
});

test('migrateLegacyRecipe: rotate/flip maps onto the exact same D4 orient state as the live UI would produce', () => {
  // 90 CW is ORIENT_TAP.rotateCW composed onto identity.
  const cw90 = migrateLegacyRecipe([legacyStep('rotate', { degrees: 90, flipH: false, flipV: false })]);
  assert.equal(cw90.recipe.orient, composeOrientStates(ORIENT_TAP.rotateCW, ORIENT_IDENTITY));
  // flipH alone.
  const flipH = migrateLegacyRecipe([legacyStep('rotate', { degrees: 0, flipH: true, flipV: false })]);
  assert.equal(flipH.recipe.orient, composeOrientStates(ORIENT_TAP.flipH, ORIENT_IDENTITY));
  // flipV alone: mirroring vertically is a flip + 180, same identity the app itself relies on.
  const flipV = migrateLegacyRecipe([legacyStep('rotate', { degrees: 0, flipH: false, flipV: true })]);
  assert.equal(flipV.recipe.orient, composeOrientStates(ORIENT_TAP.flipV, ORIENT_IDENTITY));
  // No rotate step at all → orient left unset (identity default), not forced to 0.
  assert.equal(migrateLegacyRecipe([]).recipe.orient, undefined);
});

test('migrateLegacyRecipe drops what has no fixed-recipe equivalent, with a note for each, never silently', () => {
  const legacy = [
    legacyStep('resize', { mode: 'percent', percent: 50 }),
    legacyStep('compress', { mode: 'total', totalMB: 20 }),
    legacyStep('format', { output: 'keep' }),
    legacyStep('grayscale', { method: 'luminance' }),
    legacyStep('unknownFutureOp', {}),
  ];
  const { recipe, notes } = migrateLegacyRecipe(legacy);
  assert.equal(recipe.resize, undefined);
  assert.equal(recipe.encode.maxBytes, undefined);
  assert.equal(recipe.encode.format, 'jpeg'); // sensible default, not left unset
  assert.equal(notes.length, 5); // percent, total, keep, grayscale, unknown op
  assert.ok(notes.some(n => /percent/.test(n)));
  assert.ok(notes.some(n => /total/i.test(n)));
  assert.ok(notes.some(n => /Keep original/.test(n)));
  assert.ok(notes.some(n => /Grayscale/.test(n)));
  assert.ok(notes.some(n => /unknownFutureOp/.test(n)));
});

test('migrateLegacyRecipe skips disabled steps exactly as the old UI did', () => {
  const { recipe, notes } = migrateLegacyRecipe([legacyStep('rotate', { degrees: 90 }, false)]);
  assert.equal(recipe.orient, undefined);
  assert.deepEqual(notes, []);
});

test('recipeFromHash detects a legacy (array-shaped) hash and migrates it, reporting notes', () => {
  const legacyBytes = new TextEncoder().encode(JSON.stringify([legacyStep('rename', { pattern: '{name}-{index}' })]));
  let binary = '';
  for (const b of legacyBytes) binary += String.fromCharCode(b);
  const hash = '#recipe=' + btoa(binary);
  const result = recipeFromHash(hash);
  assert.equal(result.legacy, true);
  assert.deepEqual(result.notes, []);
  assert.equal(result.recipe.output.name, '{name}-{seq:3}');
});

test('recipeFromHash accepts the old "#r=" key and the object-shaped payload the last pre-rework build wrote', () => {
  // saveRecipeToHash() in the old app: { recipe: steps, zip, rename?, frozen? }
  const payload = {
    recipe: [legacyStep('format', { output: 'png' }), legacyStep('rename', { pattern: '{name}' })],
    zip: 'batch_{date}.zip',
    rename: '{index}-{name}',   // top-level pattern took precedence over the step's own
    frozen: '2025-03-09',
  };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const result = recipeFromHash('#r=' + btoa(binary));
  assert.ok(result, 'old #r= bookmark must be recognized');
  assert.equal(result.legacy, true);
  assert.equal(result.recipe.encode.format, 'png');
  // old zip {date} was download-day → {today}; ".zip" is implied, not stored
  assert.deepEqual(result.recipe.output, { name: '{seq:3}-{name}', zip: 'batch_{today}' });
  assert.equal(result.recipe.createdDate, '2025-03-09');
  assert.deepEqual(result.notes, []);
});

test('recipeFromHash: a bare legacy array under the old "#r=" key still migrates', () => {
  const bytes = new TextEncoder().encode(JSON.stringify([legacyStep('format', { output: 'webp' })]));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const result = recipeFromHash('#r=' + btoa(binary));
  assert.equal(result.legacy, true);
  assert.equal(result.recipe.encode.format, 'webp');
});

// ── Templates: one vocabulary for the stamp and the output name ──────────
const TOKENS = { name: 'IMG_0042', seq: 7, hash: 'deadbeefcafe0123', date: '2024-05-01', today: '2026-09-02', width: 1920, height: 1080 };

test('resolveTemplate resolves every token, with {seq:N} padding and {hash:N} prefixes', () => {
  assert.equal(resolveTemplate('{date}_{name}_{seq}', TOKENS), '2024-05-01_IMG_0042_7');
  assert.equal(resolveTemplate('{seq:3}', TOKENS), '007');
  assert.equal(resolveTemplate('{hash:8}', TOKENS), 'deadbeef');
  assert.equal(resolveTemplate('{hash}', TOKENS), 'deadbeefcafe0123');
  assert.equal(resolveTemplate('{width}x{height}', TOKENS), '1920x1080');
  assert.equal(resolveTemplate('run {today}', TOKENS), 'run 2026-09-02');
  assert.equal(resolveTemplate('© {name} {date}', TOKENS), '© IMG_0042 2024-05-01');
});

test('resolveTemplate leaves a token it was not given as written, and renders a null one empty', () => {
  assert.equal(resolveTemplate('{name}-{client}', TOKENS), 'IMG_0042-{client}');
  assert.equal(resolveTemplate('{name:3}', TOKENS), '{name:3}');
  assert.equal(resolveTemplate('[{date}]', { ...TOKENS, date: null }), '[]');
  assert.equal(resolveTemplate(null, TOKENS), '');
});

test('sanitizeFilename strips characters illegal on any desktop OS and trailing dots/spaces', () => {
  assert.equal(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j'), 'abcdefghij');
  assert.equal(sanitizeFilename('  name. . '), 'name');
  assert.equal(sanitizeFilename('ünïcödé ok'), 'ünïcödé ok');
  assert.equal(sanitizeFilename(null), '');
});

test('resolveOutputBasename sanitizes the resolved name, not the template, and never yields an empty name', () => {
  assert.equal(resolveOutputBasename('{date}_{seq:3}', TOKENS), '2024-05-01_007');   // colon in {seq:3} survives
  assert.equal(resolveOutputBasename('{name}/{seq}', TOKENS), 'IMG_00427');          // slash in the *result* does not
  assert.equal(resolveOutputBasename('???', TOKENS), 'IMG_0042');                    // all-illegal → source name
  assert.equal(resolveOutputBasename('', TOKENS), 'IMG_0042');                       // empty → default {name}
  assert.equal(resolveOutputBasename(undefined, TOKENS), resolveOutputBasename(DEFAULT_OUTPUT_NAME, TOKENS));
  assert.equal(resolveOutputBasename('{seq}', { ...TOKENS, name: '***', seq: null }), 'image');
});

test('uniqueName suffixes a collision in batch order instead of overwriting', () => {
  const used = new Set();
  assert.equal(uniqueName('2024-05-01', 'jpg', used), '2024-05-01.jpg');
  assert.equal(uniqueName('2024-05-01', 'jpg', used), '2024-05-01-2.jpg');
  assert.equal(uniqueName('2024-05-01', 'jpg', used), '2024-05-01-3.jpg');
  assert.equal(uniqueName('2024-05-01', 'png', used), '2024-05-01.png'); // different extension, no collision
  assert.equal(used.size, 4);
});

test('the output slot is part of the record: canonical, ordered after encode, round-trips through the hash', () => {
  assert.ok(SLOT_KEYS.includes('output'));
  assert.ok(SLOT_KEYS.indexOf('output') > SLOT_KEYS.indexOf('encode'));
  assert.ok(SLOT_KEYS.indexOf('output') < SLOT_KEYS.indexOf('manifest'));
  const r = { manifest: true, output: { name: '{date}_{seq:3}', zip: 'set-{today}' }, encode: { format: 'jpeg' } };
  assert.deepEqual(Object.keys(canonicalRecipe(r)), ['encode', 'output', 'manifest']);
  assert.deepEqual(recipeFromHash(recipeToHash(r)).recipe.output, r.output);
  assert.equal(DEFAULT_ZIP_NAME, 'imagechef-{today}');
});

// ── Dedup: partition a file list into what gets processed and what's a
// later duplicate ─────────────────────────────────────────────────────────
test('the dedup slot is part of the record: canonical, ordered between output and manifest, round-trips through the hash', () => {
  assert.ok(SLOT_KEYS.includes('dedup'));
  assert.ok(SLOT_KEYS.indexOf('dedup') > SLOT_KEYS.indexOf('output'));
  assert.ok(SLOT_KEYS.indexOf('dedup') < SLOT_KEYS.indexOf('manifest'));
  const r = { manifest: true, dedup: { by: 'name' }, output: { name: '{name}' }, encode: { format: 'jpeg' } };
  assert.deepEqual(Object.keys(canonicalRecipe(r)), ['encode', 'output', 'dedup', 'manifest']);
  assert.deepEqual(recipeFromHash(recipeToHash(r)).recipe.dedup, { by: 'name' });
});

test('partitionDuplicates: name+size keeps the first occurrence, skips later exact repeats', () => {
  const items = [
    { name: 'a.jpg', size: 100 },
    { name: 'a.jpg', size: 100 }, // exact repeat of 0
    { name: 'b.jpg', size: 200 },
    { name: 'a.jpg', size: 999 }, // same name, different size — not a duplicate under name+size
  ];
  const { keep, skip } = partitionDuplicates(items, 'name+size');
  assert.deepEqual(keep, [0, 2, 3]);
  assert.deepEqual(skip, [{ index: 1, of: 0 }]);
});

test('partitionDuplicates: name-only mode treats same-name files as duplicates regardless of size', () => {
  const items = [
    { name: 'a.jpg', size: 100 },
    { name: 'a.jpg', size: 999 }, // same name, different size — a duplicate under name-only
    { name: 'b.jpg', size: 200 },
  ];
  const { keep, skip } = partitionDuplicates(items, 'name');
  assert.deepEqual(keep, [0, 2]);
  assert.deepEqual(skip, [{ index: 1, of: 0 }]);
});

test('partitionDuplicates: no duplicates keeps everything, in order', () => {
  const items = [{ name: 'a.jpg', size: 1 }, { name: 'b.jpg', size: 2 }, { name: 'c.jpg', size: 3 }];
  const { keep, skip } = partitionDuplicates(items, 'name+size');
  assert.deepEqual(keep, [0, 1, 2]);
  assert.deepEqual(skip, []);
});

test('partitionDuplicates: all duplicates keeps only the first, skips the rest pointing back at it', () => {
  const items = [{ name: 'a.jpg', size: 5 }, { name: 'a.jpg', size: 5 }, { name: 'a.jpg', size: 5 }];
  const { keep, skip } = partitionDuplicates(items, 'name+size');
  assert.deepEqual(keep, [0]);
  assert.deepEqual(skip, [{ index: 1, of: 0 }, { index: 2, of: 0 }]);
});

test('partitionDuplicates: an unrecognized "by" value falls back to name+size, the stricter mode', () => {
  const items = [{ name: 'a.jpg', size: 1 }, { name: 'a.jpg', size: 1 }, { name: 'a.jpg', size: 2 }];
  const withUndefined = partitionDuplicates(items, undefined);
  const withGarbage = partitionDuplicates(items, 'bogus-mode');
  const expected = partitionDuplicates(items, 'name+size');
  assert.deepEqual(withUndefined, expected);
  assert.deepEqual(withGarbage, expected);
  assert.deepEqual(expected.keep, [0, 2]);
  assert.deepEqual(expected.skip, [{ index: 1, of: 0 }]);
});

test('migrateLegacyRecipe: the old dedup op carries its "by" setting straight across', () => {
  const byNameSize = migrateLegacyRecipe([legacyStep('dedup', { by: 'name+size' })]);
  assert.deepEqual(byNameSize.recipe.dedup, { by: 'name+size' });
  assert.deepEqual(byNameSize.notes, []);
  const byName = migrateLegacyRecipe([legacyStep('dedup', { by: 'name' })]);
  assert.deepEqual(byName.recipe.dedup, { by: 'name' });
  assert.deepEqual(byName.notes, []);
  // An unrecognized `by` still migrates, falling back to the stricter mode.
  const byBogus = migrateLegacyRecipe([legacyStep('dedup', { by: 'bogus' })]);
  assert.deepEqual(byBogus.recipe.dedup, { by: 'name+size' });
});

// ── Orientation: closed group of 8 ────────────────────────────────────────
test('rotating 90 CW four times in the UI stores the identity orientation', () => {
  let state = ORIENT_IDENTITY;
  for (let i = 0; i < 4; i++) state = composeOrientStates(ORIENT_TAP.rotateCW, state);
  assert.equal(state, ORIENT_IDENTITY);
});

test('flip horizontal twice is identity', () => {
  let state = ORIENT_IDENTITY;
  state = composeOrientStates(ORIENT_TAP.flipH, state);
  state = composeOrientStates(ORIENT_TAP.flipH, state);
  assert.equal(state, ORIENT_IDENTITY);
});

test('rotate CW then CCW cancels out', () => {
  let state = composeOrientStates(ORIENT_TAP.rotateCW, ORIENT_IDENTITY);
  state = composeOrientStates(ORIENT_TAP.rotateCCW, state);
  assert.equal(state, ORIENT_IDENTITY);
});

test('composing an EXIF-implied upright transform with a user rotate is a single valid D4 state', () => {
  // Simulate: image's own EXIF says "rotate 90 CW" (state index 5), user
  // additionally taps flip-horizontal on top.
  const exifState = 5;
  const combined = composeOrientStates(ORIENT_TAP.flipH, exifState);
  assert.ok(combined >= 0 && combined <= 7);
  // Composing the exact inverse should return to the exif-only state.
  const undone = composeOrientStates(ORIENT_TAP.flipH, combined);
  assert.equal(undone, exifState);
});

// ── Resize: linear-light premultiplied resampling avoids dark fringing ───
test('downscaling opaque-color-next-to-transparent 4x does not darken the opaque side', () => {
  // 8x1 source: left 4px fully opaque red, right 4px fully transparent
  // (RGB 0,0,0 as browsers typically store it). Downscale 4x -> 2x1.
  const srcW = 8, srcH = 1, dstW = 2, dstH = 1;
  const src = new Uint8ClampedArray(srcW * srcH * 4);
  for (let x = 0; x < 4; x++) { src[x*4] = 255; src[x*4+1] = 0; src[x*4+2] = 0; src[x*4+3] = 255; }
  for (let x = 4; x < 8; x++) { src[x*4] = 0; src[x*4+1] = 0; src[x*4+2] = 0; src[x*4+3] = 0; }
  const { data } = resampleLinearPremultiplied(src, srcW, srcH, dstW, dstH);
  // The left output pixel (covering the 4 opaque red source pixels) must
  // still read as pure red, not darkened toward black by the transparent
  // neighbor's RGB values.
  assert.equal(data[0], 255, 'red channel preserved');
  assert.equal(data[1], 0);
  assert.equal(data[2], 0);
  assert.equal(data[3], 255, 'alpha preserved as opaque');
});

test('resampleLinearPremultiplied is a straight box average for a uniform image', () => {
  const srcW = 4, srcH = 4, dstW = 2, dstH = 2;
  const src = new Uint8ClampedArray(srcW * srcH * 4);
  for (let i = 0; i < srcW * srcH; i++) { src[i*4]=100; src[i*4+1]=150; src[i*4+2]=200; src[i*4+3]=255; }
  const { data } = resampleLinearPremultiplied(src, srcW, srcH, dstW, dstH);
  for (let i = 0; i < dstW * dstH; i++) {
    assert.ok(Math.abs(data[i*4] - 100) <= 1);
    assert.ok(Math.abs(data[i*4+1] - 150) <= 1);
    assert.ok(Math.abs(data[i*4+2] - 200) <= 1);
    assert.equal(data[i*4+3], 255);
  }
});

// ── Block stats: SSIM/SAD ─────────────────────────────────────────────────
function makeFrame(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r,g,b] = fn(x,y);
    const i = (y*w+x)*4;
    d[i]=r; d[i+1]=g; d[i+2]=b; d[i+3]=255;
  }
  return d;
}

test('computeBlockStats: identical images score SSIM ~1 and SAD 0', () => {
  const W=16,H=16;
  const a = makeFrame(W,H,(x,y)=>[(x*16)%256,(y*16)%256,128]);
  const stats = computeBlockStats(a, a, W, H, 8);
  assert.ok(stats.meanSsim > 0.999);
  assert.equal(stats.worstBlock.sad, 0);
});

test('computeBlockStats: a corrupted block is identified as the worst region', () => {
  const W=16,H=16;
  const a = makeFrame(W,H,() => [120,120,120]);
  const b = makeFrame(W,H,(x,y) => (x>=8 && y>=8) ? [0,0,0] : [120,120,120]);
  const stats = computeBlockStats(a, b, W, H, 8);
  assert.equal(stats.worstBlock.x, 8);
  assert.equal(stats.worstBlock.y, 8);
  assert.ok(stats.meanSsim < 0.9);
});

test('computeBlockStats: more different images score lower SSIM than less different ones', () => {
  const W=16,H=16;
  const a = makeFrame(W,H,(x,y)=>[(x*7+y*3)%256,(y*11)%256,(x*13)%256]);
  const bSmall = makeFrame(W,H,(x,y)=>{ const [r,g,bl]=[(x*7+y*3)%256,(y*11)%256,(x*13)%256]; return [Math.min(255,r+5),g,bl]; });
  const bBig = makeFrame(W,H,(x,y)=>{ const [r,g,bl]=[(x*7+y*3)%256,(y*11)%256,(x*13)%256]; return [255-r,255-g,255-bl]; });
  const statsSmall = computeBlockStats(a, bSmall, W, H, 8);
  const statsBig = computeBlockStats(a, bBig, W, H, 8);
  assert.ok(statsSmall.meanSsim > statsBig.meanSsim);
});

// ── normalizeBlockLoss: the ROI heatmap's mask math ───────────────────────
test('normalizeBlockLoss returns null with no blocks or no loss', () => {
  assert.equal(normalizeBlockLoss(null), null);
  assert.equal(normalizeBlockLoss([]), null);
  assert.equal(normalizeBlockLoss([{ x: 0, y: 0, w: 8, h: 8, sad: 0 }]), null);
});

test('normalizeBlockLoss scales every block relative to the batch max, capped at maxAlpha (gamma=1, linear)', () => {
  const blocks = [
    { x: 0, y: 0, w: 8, h: 8, sad: 100 },  // the max — should hit maxAlpha exactly
    { x: 8, y: 0, w: 8, h: 8, sad: 50 },   // half the max — half the alpha, at gamma=1
    { x: 0, y: 8, w: 8, h: 8, sad: 0 },    // no loss — zero alpha, not dropped
  ];
  const out = normalizeBlockLoss(blocks, 0.8, 1);
  assert.equal(out.length, 3);
  assert.equal(out[0].alpha, 0.8);
  assert.equal(out[1].alpha, 0.4);
  assert.equal(out[2].alpha, 0);
  // Geometry passes through unchanged — the mask must land on the right pixels.
  assert.deepEqual({ x: out[1].x, y: out[1].y, w: out[1].w, h: out[1].h }, { x: 8, y: 0, w: 8, h: 8 });
});

test('normalizeBlockLoss defaults maxAlpha so the mask never fully obscures the image', () => {
  const out = normalizeBlockLoss([{ x: 0, y: 0, w: 8, h: 8, sad: 1 }]);
  assert.equal(out[0].alpha, 0.85);
  assert.ok(out[0].alpha < 1);
});

test('normalizeBlockLoss biases through a power law: moderate loss is suppressed well below linear, the max is untouched', () => {
  const blocks = [
    { x: 0, y: 0, w: 8, h: 8, sad: 100 },
    { x: 8, y: 0, w: 8, h: 8, sad: 50 }, // half the max SAD
  ];
  const linear = normalizeBlockLoss(blocks, 0.8, 1);
  const gamma2 = normalizeBlockLoss(blocks, 0.8, 2);
  // The worst block always hits maxAlpha regardless of gamma (1^g === 1).
  assert.equal(linear[0].alpha, 0.8);
  assert.equal(gamma2[0].alpha, 0.8);
  // A gamma > 1 pulls the half-max block's tint down, not up — that's what
  // keeps ordinary, moderate compression loss from washing the image green.
  assert.ok(gamma2[1].alpha < linear[1].alpha);
  assert.equal(gamma2[1].alpha, 0.5 ** 2 * 0.8);
  // The library default (gamma=2.2) suppresses it further still.
  const defaulted = normalizeBlockLoss(blocks, 0.8);
  assert.ok(defaulted[1].alpha < gamma2[1].alpha);
});

test('normalizeBlockLoss on real computeBlockStats output: the worst block reaches maxAlpha', () => {
  const W = 16, H = 16;
  const a = makeFrame(W, H, () => [120, 120, 120]);
  const b = makeFrame(W, H, (x, y) => (x >= 8 && y >= 8) ? [0, 0, 0] : [120, 120, 120]);
  const stats = computeBlockStats(a, b, W, H, 8);
  const mask = normalizeBlockLoss(stats.blocks);
  const worst = mask.find(m => m.x === 8 && m.y === 8);
  assert.equal(worst.alpha, 0.85);
  // Untouched blocks carry zero loss, not omitted from the mask.
  const untouched = mask.find(m => m.x === 0 && m.y === 0);
  assert.equal(untouched.alpha, 0);
});

// ── PNG tEXt injection round-trips ────────────────────────────────────────
function minimalPng() {
  // SIG + IHDR(13 bytes of zeros, doesn't need to be valid for this test) + IEND
  const sig = [0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A];
  const ihdrData = new Uint8Array(13);
  const ihdrCrcInput = new Uint8Array([...'IHDR'].map(c=>c.charCodeAt(0)).concat([...ihdrData]));
  // crc32 not needed to be correct for our reader (it only checks type/length)
  const ihdr = [...u32be(13), ...[...'IHDR'].map(c=>c.charCodeAt(0)), ...ihdrData, ...u32be(0)];
  const iend = [...u32be(0), ...[...'IEND'].map(c=>c.charCodeAt(0)), ...u32be(0)];
  function u32be(n) { return [(n>>>24)&0xFF,(n>>>16)&0xFF,(n>>>8)&0xFF,n&0xFF]; }
  return new Uint8Array([...sig, ...ihdr, ...iend]);
}

test('injectPngText + readPngText round-trip a copyright field', () => {
  const png = minimalPng();
  const withText = injectPngText(png, { Copyright: 'Jane Doe 2026' });
  assert.ok(withText.length > png.length);
  const read = readPngText(withText);
  assert.equal(read.Copyright, 'Jane Doe 2026');
});

test('injectPngText is a no-op when no fields are given', () => {
  const png = minimalPng();
  const out = injectPngText(png, {});
  assert.equal(out, png);
});

// ── The browser's own encoder tags color space whether asked or not; we
// strip that by default so "strip-all metadata" is actually true ─────────
function pngWithColorChunks() {
  const base = minimalPng(); // SIG + IHDR + IEND
  const sig = base.subarray(0, 8);
  const ihdr = base.subarray(8, 8 + 8 + 13 + 4);
  const iend = base.subarray(8 + 8 + 13 + 4);
  function u32be(n) { return [(n>>>24)&0xFF,(n>>>16)&0xFF,(n>>>8)&0xFF,n&0xFF]; }
  const srgb = new Uint8Array([...u32be(1), ...[...'sRGB'].map(c=>c.charCodeAt(0)), 0, ...u32be(0)]);
  const text = new Uint8Array([...u32be(4), ...[...'tEXt'].map(c=>c.charCodeAt(0)), ...[...'A\0hi'].map(c=>c.charCodeAt(0)), ...u32be(0)]);
  return new Uint8Array([...sig, ...ihdr, ...srgb, ...text, ...iend]);
}

test('stripPngColorChunks removes sRGB but keeps other chunks (tEXt)', () => {
  const png = pngWithColorChunks();
  const stripped = stripPngColorChunks(png);
  assert.ok(stripped.length < png.length);
  const text = readPngText(stripped);
  assert.equal(text.A, 'hi', 'non-color chunk survives');
  // No sRGB chunk type should remain.
  let p = 8, found = false;
  while (p + 8 <= stripped.length) {
    const len = (stripped[p]<<24|stripped[p+1]<<16|stripped[p+2]<<8|stripped[p+3])>>>0;
    const type = String.fromCharCode(stripped[p+4],stripped[p+5],stripped[p+6],stripped[p+7]);
    if (type === 'sRGB') found = true;
    if (type === 'IEND') break;
    p += 8 + len + 4;
  }
  assert.equal(found, false);
});

// ── Minimal JPEG EXIF writer: retains ONLY the named field ────────────────
function readTagsFromExifSegment(seg) {
  // Minimal reader mirroring the JPEG-META-LIB conventions, local to this test.
  const b = seg.subarray(4 + 6); // skip APP1 marker/len + "Exif\0\0"
  const le = b[0] === 0x49;
  const u16 = o => le ? (b[o] | (b[o+1]<<8)) : ((b[o]<<8)|b[o+1]);
  const u32 = o => le ? (b[o] + b[o+1]*256 + b[o+2]*65536 + b[o+3]*16777216) : (b[o]*16777216+b[o+1]*65536+b[o+2]*256+b[o+3]);
  const ifd0 = u32(4);
  const count = u16(ifd0);
  const tags = [];
  for (let i = 0, e = ifd0 + 2; i < count; i++, e += 12) tags.push(u16(e));
  return tags;
}

test('writeMinimalJpegExif embeds only the requested tag', () => {
  const seg = writeMinimalJpegExif({ copyright: 'Jane Doe' });
  const tags = readTagsFromExifSegment(seg);
  assert.deepEqual(tags, [0x8298]);
});

test('injectJpegMinimalExif result contains the copyright field and nothing else', () => {
  const fakeJpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]); // SOI + EOI
  const out = injectJpegMinimalExif(fakeJpeg, { copyright: 'Jane Doe', artist: undefined, description: undefined });
  assert.equal(out[0], 0xFF); assert.equal(out[1], 0xD8); // SOI first
  assert.equal(out[2], 0xFF); assert.equal(out[3], 0xE1); // APP1 right after
  const len = (out[4] << 8) | out[5];
  const seg = out.subarray(2, 2 + 2 + len);
  const tags = readTagsFromExifSegment(seg);
  assert.deepEqual(tags, [0x8298], 'only copyright tag present, no GPS/artist/etc');
});

test('injectJpegMinimalExif is a no-op when nothing is retained', () => {
  const fakeJpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]);
  const out = injectJpegMinimalExif(fakeJpeg, {});
  assert.deepEqual([...out], [...fakeJpeg]);
});
