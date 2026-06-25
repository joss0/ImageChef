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

const { readJpegMetaSegments, normalizeExifSegment, spliceJpegMeta, readJpegOrientation } =
  new Function(block[1] + '\nreturn { readJpegMetaSegments, normalizeExifSegment, spliceJpegMeta, readJpegOrientation };')();

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

// Orientation value lives at: seg 10 (TIFF) + 8 (IFD0) + 2 (entry count) + 8 (value field) = 28.
const ORIENT_OFF = 28;

test('normalizeExifSegment forces Orientation to 1', () => {
  const seg = buildExifSegment();
  assert.equal(readU16LE(seg, ORIENT_OFF), 6, 'fixture starts at Orientation 6');
  const fixed = normalizeExifSegment(seg, 800, 600);
  assert.equal(readU16LE(fixed, ORIENT_OFF), 1, 'Orientation normalised to 1');
});

test('normalizeExifSegment refreshes Exif pixel dimensions', () => {
  const seg = buildExifSegment();
  // ExifIFD @ tiff+38 = 48; entry0 (PixelX) value @ 48+2+8 = 58, entry1 (PixelY) value @ 58+12 = 70
  assert.equal(readU32LE(seg, 58), 4000);
  assert.equal(readU32LE(seg, 70), 3000);
  const fixed = normalizeExifSegment(seg, 800, 600);
  assert.equal(readU32LE(fixed, 58), 800, 'PixelXDimension updated');
  assert.equal(readU32LE(fixed, 70), 600, 'PixelYDimension updated');
});

test('normalizeExifSegment does not change segment length (in-place edits)', () => {
  const seg = buildExifSegment();
  const fixed = normalizeExifSegment(seg, 1, 1);
  assert.equal(fixed.length, seg.length);
});

test('spliceJpegMeta round-trips: metadata survives re-attach to a clean JPEG', () => {
  const original = concat(SOI, buildExifSegment(), JFIF, ICC, SOS, EOI);
  const meta = readJpegMetaSegments(original);

  // A freshly "canvas-encoded" output with no metadata, just JFIF + scan.
  const encoded = concat(SOI, JFIF, SOS, EOI);
  const merged = spliceJpegMeta(encoded, meta, 800, 600);

  assert.ok(merged.length > encoded.length, 'output grew by the spliced segments');
  // Segments must sit immediately after SOI.
  assert.equal(merged[0], 0xFF); assert.equal(merged[1], 0xD8);
  assert.equal(merged[2], 0xFF); assert.equal(merged[3], 0xE1);

  const reread = readJpegMetaSegments(merged);
  assert.ok(reread.exif, 'EXIF readable after splice');
  assert.equal(reread.icc.length, 1, 'ICC readable after splice');
  // And the re-attached EXIF carries the normalised orientation.
  assert.equal(readU16LE(reread.exif, ORIENT_OFF), 1, 'orientation normalised in output');
});

test('spliceJpegMeta is a no-op when there is nothing to add', () => {
  const encoded = concat(SOI, JFIF, SOS, EOI);
  const meta = { exif: null, xmp: null, icc: [] };
  const merged = spliceJpegMeta(encoded, meta, 100, 100);
  assert.equal(merged, encoded, 'returns the same array reference unchanged');
});

test('spliceJpegMeta leaves non-JPEG output untouched', () => {
  const notJpeg = Uint8Array.from([1, 2, 3, 4]);
  const meta = { exif: buildExifSegment(), xmp: null, icc: [] };
  assert.equal(spliceJpegMeta(notJpeg, meta, 10, 10), notJpeg);
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
