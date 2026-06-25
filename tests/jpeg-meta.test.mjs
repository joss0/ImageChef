// Unit tests for ImageChef's JPEG metadata-preservation helpers.
//
// The helpers live inside the single-file app (index.html), delimited by the
// JPEG-META-LIB sentinels. We extract that block and evaluate it here so the
// shipped code is what's under test — there is no separate source of truth.
//
// Run with:  node --test   (or  npm test )

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ── Load the helpers straight out of index.html ──────────────────
const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const block = html.match(
  /\/\/ ===== JPEG-META-LIB-START =====([\s\S]*?)\/\/ ===== JPEG-META-LIB-END =====/
);
assert.ok(block, 'JPEG-META-LIB block not found in index.html');

const { readJpegMetaSegments, stripJpegMeta, readJpegOrientation, readJpegDateTimeOriginal } =
  new Function(block[1] + '\nreturn { readJpegMetaSegments, stripJpegMeta, readJpegOrientation, readJpegDateTimeOriginal };')();

// ── Synthetic JPEG builders ──────────────────────────────────────
// A minimal, valid-enough JPEG with a hand-built little-endian EXIF block
// carrying Orientation=6 and Exif PixelX/PixelY dimensions, plus a JFIF APP0
// and (optionally) an ICC APP2 segment.

function buildExifSegment() {
  // TIFF body (little-endian "II"), offsets relative to TIFF start (= 0):
  //   IFD0 @8 : Orientation(0x0112 SHORT=6), ExifIFD ptr(0x8769 LONG=38)
  //   ExifIFD @38 : PixelXDimension(0xA002 LONG=4000), PixelYDimension(0xA003 LONG=3000)
  const tiff = new Uint8Array(68);
  const dv = new DataView(tiff.buffer);
  const LE = true;
  tiff[0] = 0x49; tiff[1] = 0x49;          // "II"
  dv.setUint16(2, 0x2A, LE);               // magic 42
  dv.setUint32(4, 8, LE);                  // IFD0 offset

  // IFD0
  dv.setUint16(8, 2, LE);                  // 2 entries
  // entry 1: Orientation
  dv.setUint16(10, 0x0112, LE); dv.setUint16(12, 3, LE); dv.setUint32(14, 1, LE); dv.setUint16(18, 6, LE);
  // entry 2: Exif IFD pointer
  dv.setUint16(22, 0x8769, LE); dv.setUint16(24, 4, LE); dv.setUint32(26, 1, LE); dv.setUint32(30, 38, LE);
  dv.setUint32(34, 0, LE);                 // next-IFD = none

  // Exif sub-IFD @38
  dv.setUint16(38, 2, LE);                 // 2 entries
  dv.setUint16(40, 0xA002, LE); dv.setUint16(42, 4, LE); dv.setUint32(44, 1, LE); dv.setUint32(48, 4000, LE);
  dv.setUint16(52, 0xA003, LE); dv.setUint16(54, 4, LE); dv.setUint32(56, 1, LE); dv.setUint32(60, 3000, LE);
  dv.setUint32(64, 0, LE);                 // next-IFD = none

  const exifSig = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const payloadLen = exifSig.length + tiff.length;       // bytes after the length field, minus its own 2
  const len = payloadLen + 2;                            // length field counts itself
  const seg = new Uint8Array(4 + payloadLen);
  seg[0] = 0xFF; seg[1] = 0xE1; seg[2] = (len >> 8) & 0xFF; seg[3] = len & 0xFF;
  seg.set(exifSig, 4);
  seg.set(tiff, 4 + exifSig.length);
  return seg;
}

// EXIF segment carrying a DateTimeOriginal (0x9003) in the Exif sub-IFD.
// `dt` is an EXIF datetime string like "2021:07:04 12:34:56" (19 chars).
function buildExifWithDate(dt) {
  const LE = true;
  // TIFF: IFD0 (1 entry: Exif ptr) → ExifIFD (1 entry: DateTimeOriginal) → string.
  // Offsets relative to TIFF start:
  //   IFD0 @8: count@8, entry@10, next@22  → ExifIFD @26
  //   ExifIFD @26: count@26, entry@28, next@40 → string @44 (20 bytes)
  const strBytes = dt + '\0';
  const tiff = new Uint8Array(44 + 20);
  const dv = new DataView(tiff.buffer);
  tiff[0] = 0x49; tiff[1] = 0x49;
  dv.setUint16(2, 0x2A, LE);
  dv.setUint32(4, 8, LE);
  // IFD0
  dv.setUint16(8, 1, LE);
  dv.setUint16(10, 0x8769, LE); dv.setUint16(12, 4, LE); dv.setUint32(14, 1, LE); dv.setUint32(18, 26, LE);
  dv.setUint32(22, 0, LE);
  // Exif sub-IFD
  dv.setUint16(26, 1, LE);
  dv.setUint16(28, 0x9003, LE); dv.setUint16(30, 2, LE); dv.setUint32(32, 20, LE); dv.setUint32(36, 44, LE);
  dv.setUint32(40, 0, LE);
  for (let i = 0; i < 20; i++) tiff[44 + i] = i < strBytes.length ? strBytes.charCodeAt(i) : 0;

  const exifSig = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const payloadLen = exifSig.length + tiff.length;
  const len = payloadLen + 2;
  const seg = new Uint8Array(4 + payloadLen);
  seg[0] = 0xFF; seg[1] = 0xE1; seg[2] = (len >> 8) & 0xFF; seg[3] = len & 0xFF;
  seg.set(exifSig, 4);
  seg.set(tiff, 4 + exifSig.length);
  return seg;
}

function buildAppSeg(marker, sigStr, extraBytes = []) {
  const sig = [...sigStr].map(c => c.charCodeAt(0));
  const payload = [...sig, ...extraBytes];
  const len = payload.length + 2;
  const seg = new Uint8Array(4 + payload.length);
  seg[0] = 0xFF; seg[1] = marker; seg[2] = (len >> 8) & 0xFF; seg[3] = len & 0xFF;
  seg.set(payload, 4);
  return seg;
}

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

const SOI = Uint8Array.from([0xFF, 0xD8]);
const EOI = Uint8Array.from([0xFF, 0xD9]);
const SOS = Uint8Array.from([0xFF, 0xDA, 0x00, 0x08, 1, 2, 3, 4, 5, 6]); // start of scan (+ junk)
const JFIF = buildAppSeg(0xE0, 'JFIF\0', [0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
const ICC = buildAppSeg(0xE2, 'ICC_PROFILE\0', [0x01, 0x01, 0xDE, 0xAD, 0xBE, 0xEF]);

// EXIF byte-order helpers used by assertions (matches little-endian fixtures).
function readU16LE(b, o) { return b[o] | (b[o + 1] << 8); }
function readU32LE(b, o) { return b[o] + b[o + 1] * 256 + b[o + 2] * 65536 + b[o + 3] * 16777216; }

// ── Tests ────────────────────────────────────────────────────────

test('readJpegMetaSegments rejects non-JPEG input', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A]);
  const r = readJpegMetaSegments(png);
  assert.equal(r.isJpeg, false);
  assert.equal(r.exif, null);
  assert.equal(r.icc.length, 0);
});

test('readJpegMetaSegments finds EXIF and ICC, ignores image data', () => {
  const jpeg = concat(SOI, buildExifSegment(), JFIF, ICC, SOS, EOI);
  const r = readJpegMetaSegments(jpeg);
  assert.equal(r.isJpeg, true);
  assert.ok(r.exif, 'EXIF segment captured');
  assert.equal(r.exif[0], 0xFF);
  assert.equal(r.exif[1], 0xE1);
  assert.equal(r.icc.length, 1, 'ICC segment captured');
  assert.equal(r.xmp, null, 'no XMP present');
});

test('readJpegMetaSegments reports none when there is no metadata', () => {
  const jpeg = concat(SOI, JFIF, SOS, EOI);
  const r = readJpegMetaSegments(jpeg);
  assert.equal(r.isJpeg, true);
  assert.equal(r.exif, null);
  assert.equal(r.xmp, null);
  assert.equal(r.icc.length, 0);
});

test('stripJpegMeta losslessly removes EXIF and ICC, keeps everything else', () => {
  const original = concat(SOI, buildExifSegment(), JFIF, ICC, SOS, EOI);
  const stripped = stripJpegMeta(original);

  assert.ok(stripped.length < original.length, 'output shrank by the removed segments');
  const r = readJpegMetaSegments(stripped);
  assert.equal(r.isJpeg, true);
  assert.equal(r.exif, null, 'EXIF removed');
  assert.equal(r.icc.length, 0, 'ICC removed');

  // JFIF (APP0) and the entropy-coded scan must remain untouched.
  assert.equal(stripped[2], 0xFF); assert.equal(stripped[3], 0xE0, 'JFIF APP0 kept right after SOI');
  assert.equal(stripped[stripped.length - 2], 0xFF);
  assert.equal(stripped[stripped.length - 1], 0xD9, 'EOI preserved');
});

test('stripJpegMeta is a no-op on a JPEG with no metadata', () => {
  const clean = concat(SOI, JFIF, SOS, EOI);
  const stripped = stripJpegMeta(clean);
  assert.deepEqual([...stripped], [...clean]);
});

test('stripJpegMeta leaves non-JPEG input untouched', () => {
  const notJpeg = Uint8Array.from([1, 2, 3, 4]);
  assert.equal(stripJpegMeta(notJpeg), notJpeg);
});

test('stripJpegMeta preserves a short trailing marker (EOI) after the dropped segment', () => {
  // SOI + APP1(EXIF) + EOI, with nothing (no SOS) after the metadata.
  const jpeg = concat(SOI, buildExifSegment(), EOI);
  const stripped = stripJpegMeta(jpeg);
  assert.deepEqual([...stripped], [0xFF, 0xD8, 0xFF, 0xD9], 'SOI + EOI survive, EXIF removed');
});

test('readJpegDateTimeOriginal parses the capture date as YYYY-MM-DD', () => {
  const jpeg = concat(SOI, buildExifWithDate('2021:07:04 12:34:56'), JFIF, SOS, EOI);
  assert.equal(readJpegDateTimeOriginal(jpeg), '2021-07-04');
});

test('readJpegDateTimeOriginal returns null without a date tag', () => {
  const jpeg = concat(SOI, buildExifSegment(), JFIF, SOS, EOI); // EXIF present, no DateTimeOriginal
  assert.equal(readJpegDateTimeOriginal(jpeg), null);
  assert.equal(readJpegDateTimeOriginal(concat(SOI, JFIF, SOS, EOI)), null);
});

test('readJpegOrientation extracts the EXIF Orientation tag', () => {
  const jpeg = concat(SOI, buildExifSegment(), JFIF, SOS, EOI); // fixture has Orientation = 6
  assert.equal(readJpegOrientation(jpeg), 6);
});

test('readJpegOrientation returns null when there is no EXIF', () => {
  const jpeg = concat(SOI, JFIF, SOS, EOI);
  assert.equal(readJpegOrientation(jpeg), null);
  assert.equal(readJpegOrientation(Uint8Array.from([0x89, 0x50])), null); // non-JPEG
});
