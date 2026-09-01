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
    canonicalRecipe, recipeIdentity, SLOT_KEYS,
    ORIENT_STATES, ORIENT_TAP, ORIENT_IDENTITY, composeOrientStates,
    resampleAxis, resampleLinearPremultiplied,
    computeBlockStats, normalizeBlockLoss,
    injectPngText, readPngText, stripPngColorChunks,
    writeMinimalJpegExif, injectJpegMinimalExif,
  };
`)();

const {
  canonicalRecipe, recipeIdentity,
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

test('normalizeBlockLoss scales every block relative to the batch max, capped at maxAlpha', () => {
  const blocks = [
    { x: 0, y: 0, w: 8, h: 8, sad: 100 },  // the max — should hit maxAlpha exactly
    { x: 8, y: 0, w: 8, h: 8, sad: 50 },   // half the max — half the alpha
    { x: 0, y: 8, w: 8, h: 8, sad: 0 },    // no loss — zero alpha, not dropped
  ];
  const out = normalizeBlockLoss(blocks, 0.8);
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
