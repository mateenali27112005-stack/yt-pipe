/**
 * V0.7 QC Engine — Deterministic Tests
 *
 * All tests use real temporary files. No mocks. No network. No FFmpeg.
 * PNG bytes are minimal but structurally valid (header + IHDR + IDAT + IEND).
 * AIFF bytes are minimal but structurally valid (FORM + COMM + SSND).
 *
 * The goal: verify every QC detection path with byte-level precision.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeflate } from "node:zlib";
import { Readable } from "node:stream";
import test from "node:test";

import { runEpisodeQC, checkVisualAsset, checkAudioAsset, DEFAULT_QC_THRESHOLDS } from "../src/qc.ts";
import type { FinalCompositionSpec } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Minimal valid PNG builder
// ---------------------------------------------------------------------------

function deflateSyncLike(data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const deflate = createDeflate({ level: 1 });
    const chunks: Buffer[] = [];
    deflate.on("data", (c: Buffer) => chunks.push(c));
    deflate.on("end", () => resolve(Buffer.concat(chunks)));
    deflate.on("error", reject);
    Readable.from(data).pipe(deflate);
  });
}

function crc32(data: Buffer): number {
  const table = (() => {
    const t: number[] = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makePNGChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, "ascii");
  const crcData = Buffer.concat([typeBytes, data]);
  const crcBuf = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcData));
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

async function buildPNG(
  width: number,
  height: number,
  fillR = 128, fillG = 128, fillB = 128
): Promise<Buffer> {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR
  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;       // bit depth
  ihdrData[9] = 2;       // color type: RGB
  ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;

  // Raw pixel data (filter byte 0 per scanline + RGB)
  const rawRows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = fillR;
      row[1 + x * 3 + 1] = fillG;
      row[1 + x * 3 + 2] = fillB;
    }
    rawRows.push(row);
  }
  const rawPixels = Buffer.concat(rawRows);
  const compressed = await deflateSyncLike(rawPixels);

  const iend = Buffer.alloc(0);

  return Buffer.concat([
    PNG_SIG,
    makePNGChunk("IHDR", ihdrData),
    makePNGChunk("IDAT", compressed),
    makePNGChunk("IEND", iend),
  ]);
}

// ---------------------------------------------------------------------------
// Minimal valid AIFF builder
// ---------------------------------------------------------------------------

/** AIFF chunk: [type:4][size:4][data] — no CRC, no leading size. */
function makeAIFFChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

function ieee80(sampleRate: number): Buffer {
  // Encode sample rate as 80-bit IEEE 754 extended precision.
  // Normalise: shift mantissa left until top bit of a 32-bit word is set,
  // stopping before we exceed 2^32 (which would overflow writeUInt32BE).
  const buf = Buffer.alloc(10);
  let exponent = 16383 + 31; // bias + 31 (we target [2^31, 2^32) range)
  let m = sampleRate;
  while (m < 0x80000000) { m *= 2; exponent--; }
  // m is now in [2^31, 2^32) — safe for writeUInt32BE
  const mHigh = Math.floor(m) >>> 0;
  buf.writeUInt16BE(exponent & 0x7fff, 0);
  buf.writeUInt32BE(mHigh, 2);
  buf.writeUInt32BE(0, 6);
  return buf;
}

function buildAIFF(
  sampleRate: number,
  numFrames: number,
  fillAmplitude = 0.5  // -1.0 to 1.0
): Buffer {
  const numChannels = 1;
  const sampleSize = 16;
  const bytesPerSample = 2;

  // COMM chunk
  const commData = Buffer.alloc(18);
  commData.writeInt16BE(numChannels, 0);
  commData.writeUInt32BE(numFrames, 2);
  commData.writeInt16BE(sampleSize, 6);
  ieee80(sampleRate).copy(commData, 8);

  // SSND chunk: 8-byte header (offset + blockSize) + PCM
  const ssndHeader = Buffer.alloc(8); // offset=0, blockSize=0
  const pcmData = Buffer.alloc(numFrames * bytesPerSample);
  const sampleValue = Math.round(fillAmplitude * 32767);
  for (let i = 0; i < numFrames; i++) {
    pcmData.writeInt16BE(sampleValue, i * 2);
  }
  const ssndData = Buffer.concat([ssndHeader, pcmData]);

  const commChunk = makeAIFFChunk("COMM", commData);
  const ssndChunk = makeAIFFChunk("SSND", ssndData);
  const body = Buffer.concat([commChunk, ssndChunk]);

  const formHeader = Buffer.alloc(12);
  formHeader.write("FORM", 0, "ascii");
  formHeader.writeUInt32BE(4 + body.length, 4);
  formHeader.write("AIFF", 8, "ascii");

  return Buffer.concat([formHeader, body]);
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeComposition(overrides: {
  pngPath?: string;
  aiffPath?: string;
  canvasWidth?: number;
  canvasHeight?: number;
  audioDuration?: number;
} = {}): FinalCompositionSpec {
  return {
    schemaVersion: "0.1",
    compositionVersion: 1,
    episodeId: "EP_QC_001",
    sourceSpecVersion: 1,
    sourceTimelineVersion: 1,
    sourceMotionPlanVersion: 1,
    sourceVisualSpecVersion: 1,
    sourceAssetManifestRevision: 1,
    generatedAt: "2026-09-26T00:00:00.000Z",
    durationSeconds: overrides.audioDuration ?? 2,
    visualComposition: {
      canvas: {
        width: overrides.canvasWidth ?? 4,
        height: overrides.canvasHeight ?? 4,
        frameRate: 24,
      },
      shots: [{
        id: "MCP_SH_001",
        sceneId: "SC_001",
        shotId: "SH_001",
        visualAsset: {
          assetId: "VAS_SH_001",
          assetVersionId: "VAS_SH_001_v1",
          path: overrides.pngPath ?? "assets/shot.png",
          sha256: "a".repeat(64),
        },
        timing: { startSeconds: 0, endSeconds: 2, durationSeconds: 2 },
        camera: {
          intent: "static",
          keyframes: [{ offset: 0, scale: 1, x: 0.5, y: 0.5 }],
        },
        sourceHash: "b".repeat(64),
      }],
    },
    narrationDialogueTracks: [{
      id: "MIX_SH_001",
      audioAssetId: "AST_SH_001",
      path: overrides.aiffPath ?? "assets/narration.aiff",
      role: "narration",
      startSeconds: 0,
      endSeconds: overrides.audioDuration ?? 2,
      gainDb: 0,
      format: "aiff",
      durationSeconds: overrides.audioDuration ?? 2,
      voice: "Narrator",
    }],
    musicCues: [],
    sfxCues: [],
    captions: [],
    sourceHash: "c".repeat(64),
  };
}

interface QCFixture {
  root: string;
  pngPath: string;
  aiffPath: string;
  composition: FinalCompositionSpec;
  cleanup: () => void;
}

async function makeFixture(overrides: {
  pngWidth?: number;
  pngHeight?: number;
  pngR?: number; pngG?: number; pngB?: number;
  aiffAmplitude?: number;
  aiffFrames?: number;
  aiffSampleRate?: number;
  audioDuration?: number;
  canvasWidth?: number;
  canvasHeight?: number;
  writePng?: boolean;
  writeAiff?: boolean;
} = {}): Promise<QCFixture> {
  const root = mkdtempSync(join(tmpdir(), "yt-pipe-qc-"));
  mkdirSync(join(root, "assets"), { recursive: true });

  const pngPath = "assets/shot.png";
  const aiffPath = "assets/narration.aiff";

  const shouldWritePng = overrides.writePng !== false;
  const shouldWriteAiff = overrides.writeAiff !== false;

  if (shouldWritePng) {
    const pngBuf = await buildPNG(
      overrides.pngWidth ?? 4,
      overrides.pngHeight ?? 4,
      overrides.pngR ?? 128,
      overrides.pngG ?? 128,
      overrides.pngB ?? 128
    );
    writeFileSync(join(root, pngPath), pngBuf);
  }

  if (shouldWriteAiff) {
    const sampleRate = overrides.aiffSampleRate ?? 44100;
    const audioDuration = overrides.audioDuration ?? 2;
    const numFrames = overrides.aiffFrames ?? Math.round(sampleRate * audioDuration);
    const aiffBuf = buildAIFF(sampleRate, numFrames, overrides.aiffAmplitude ?? 0.5);
    writeFileSync(join(root, aiffPath), aiffBuf);
  }

  const composition = makeComposition({
    pngPath,
    aiffPath,
    canvasWidth: overrides.canvasWidth ?? 4,
    canvasHeight: overrides.canvasHeight ?? 4,
    audioDuration: overrides.audioDuration ?? 2,
  });

  return {
    root,
    pngPath: join(root, pngPath),
    aiffPath: join(root, aiffPath),
    composition,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Visual QC tests
// ---------------------------------------------------------------------------

test("visual QC: PASS for a normal-brightness RGB PNG", async () => {
  const f = await makeFixture({ pngR: 128, pngG: 128, pngB: 128 });
  try {
    const result = await checkVisualAsset(
      "SH_001",
      { assetId: "VAS_001", assetVersionId: "v1", path: f.pngPath },
      4, 4,
      "" // absolute path already
    );
    assert.equal(result.status, "PASS");
    assert.equal(result.reasons.length, 0);
    assert.ok(result.luminance);
    assert.ok(result.luminance.mean > 0.1, `mean should be > 0.1, got ${result.luminance.mean}`);
  } finally { f.cleanup(); }
});

test("visual QC: FAIL with BLACK_FRAME for a fully black PNG", async () => {
  const f = await makeFixture({ pngR: 0, pngG: 0, pngB: 0 });
  try {
    const result = await checkVisualAsset(
      "SH_001",
      { assetId: "VAS_001", assetVersionId: "v1", path: f.pngPath },
      4, 4,
      ""
    );
    assert.equal(result.status, "FAIL");
    assert.ok(result.reasons.includes("BLACK_FRAME"));
    assert.ok(result.luminance);
    assert.ok(result.luminance.mean < 0.02, `mean should be < 0.02, got ${result.luminance.mean}`);
  } finally { f.cleanup(); }
});

test("visual QC: WARN with NEAR_BLACK_FRAME for very dark PNG", async () => {
  // luminance ≈ 0.039 (10/255 per channel)
  const f = await makeFixture({ pngR: 10, pngG: 10, pngB: 10 });
  try {
    const result = await checkVisualAsset(
      "SH_001",
      { assetId: "VAS_001", assetVersionId: "v1", path: f.pngPath },
      4, 4,
      ""
    );
    // mean ≈ 0.039 which is >= 0.02 threshold but < 0.05 — should be WARN
    assert.equal(result.status, "WARN");
    assert.ok(result.reasons.includes("NEAR_BLACK_FRAME"));
  } finally { f.cleanup(); }
});

test("visual QC: FAIL with MISSING_FILE when PNG does not exist", async () => {
  const result = await checkVisualAsset(
    "SH_001",
    { assetId: "VAS_001", assetVersionId: "v1", path: "/nonexistent/path/shot.png" },
    4, 4,
    ""
  );
  assert.equal(result.status, "FAIL");
  assert.ok(result.reasons.includes("MISSING_FILE"));
});

test("visual QC: FAIL with FORMAT_ERROR for non-PNG file", async () => {
  const f = await makeFixture({ writePng: false, writeAiff: false });
  try {
    const badPath = join(f.root, "assets/bad.png");
    writeFileSync(badPath, Buffer.from("this is not a PNG file"));
    const result = await checkVisualAsset(
      "SH_001",
      { assetId: "VAS_001", assetVersionId: "v1", path: badPath },
      4, 4,
      ""
    );
    assert.equal(result.status, "FAIL");
    assert.ok(result.reasons.includes("FORMAT_ERROR"));
  } finally { f.cleanup(); }
});

test("visual QC: FAIL with WRONG_DIMENSIONS when image size mismatches canvas", async () => {
  // Build a 4x4 PNG but expect 1920x1080
  const f = await makeFixture({ pngWidth: 4, pngHeight: 4, canvasWidth: 1920, canvasHeight: 1080 });
  try {
    const pngBuf = await buildPNG(4, 4, 128, 128, 128);
    writeFileSync(join(f.root, "assets/shot.png"), pngBuf);
    const result = await checkVisualAsset(
      "SH_001",
      { assetId: "VAS_001", assetVersionId: "v1", path: join(f.root, "assets/shot.png") },
      1920, 1080,
      ""
    );
    assert.equal(result.status, "FAIL");
    assert.ok(result.reasons.includes("WRONG_DIMENSIONS"));
    assert.equal(result.actualWidth, 4);
    assert.equal(result.actualHeight, 4);
    assert.equal(result.expectedWidth, 1920);
    assert.equal(result.expectedHeight, 1080);
  } finally { f.cleanup(); }
});

// ---------------------------------------------------------------------------
// Audio QC tests
// ---------------------------------------------------------------------------

const NARRATION_TRACK: FinalCompositionSpec["narrationDialogueTracks"][number] = {
  id: "MIX_SH_001",
  audioAssetId: "AST_SH_001",
  path: "/placeholder",
  role: "narration",
  startSeconds: 0,
  endSeconds: 2,
  gainDb: 0,
  format: "aiff",
  durationSeconds: 2,
  voice: "Narrator",
};

test("audio QC: PASS for a normal-amplitude AIFF", async () => {
  const f = await makeFixture({ aiffAmplitude: 0.5, audioDuration: 2 });
  try {
    const track = { ...NARRATION_TRACK, path: f.aiffPath };
    const result = await checkAudioAsset("SH_001", track, "", DEFAULT_QC_THRESHOLDS);
    assert.equal(result.status, "PASS");
    assert.equal(result.reasons.length, 0);
    assert.ok(result.amplitude);
    assert.ok(result.amplitude.rms > 0.001);
  } finally { f.cleanup(); }
});

test("audio QC: FAIL with FULL_SILENCE for a zero-amplitude AIFF", async () => {
  const f = await makeFixture({ aiffAmplitude: 0 });
  try {
    const track = { ...NARRATION_TRACK, path: f.aiffPath };
    const result = await checkAudioAsset("SH_001", track, "", DEFAULT_QC_THRESHOLDS);
    assert.equal(result.status, "FAIL");
    assert.ok(result.reasons.includes("FULL_SILENCE"));
    assert.ok(result.amplitude);
    assert.ok(result.amplitude.rms < 0.001);
  } finally { f.cleanup(); }
});

test("audio QC: WARN with CLIPPING_DETECTED for near-full-scale amplitude", async () => {
  // amplitude 0.995 → peak ≈ 0.995 which is >= 0.99 clipping threshold
  const f = await makeFixture({ aiffAmplitude: 0.995 });
  try {
    const track = { ...NARRATION_TRACK, path: f.aiffPath };
    const result = await checkAudioAsset("SH_001", track, "", DEFAULT_QC_THRESHOLDS);
    // Should be WARN (clipping is a warning, not a hard fail)
    assert.ok(result.reasons.includes("CLIPPING_DETECTED"), `expected CLIPPING_DETECTED in ${result.reasons}`);
  } finally { f.cleanup(); }
});

test("audio QC: FAIL with MISSING_FILE when AIFF does not exist", async () => {
  const track = { ...NARRATION_TRACK, path: "/nonexistent/narration.aiff" };
  const result = await checkAudioAsset("SH_001", track, "", DEFAULT_QC_THRESHOLDS);
  assert.equal(result.status, "FAIL");
  assert.ok(result.reasons.includes("MISSING_FILE"));
});

test("audio QC: FAIL with FORMAT_ERROR for corrupt AIFF", async () => {
  const f = await makeFixture({ writeAiff: false, writePng: false });
  try {
    const badPath = join(f.root, "assets/bad.aiff");
    writeFileSync(badPath, Buffer.from("this is not an AIFF file at all"));
    const track = { ...NARRATION_TRACK, path: badPath };
    const result = await checkAudioAsset("SH_001", track, "", DEFAULT_QC_THRESHOLDS);
    assert.equal(result.status, "FAIL");
    assert.ok(result.reasons.includes("FORMAT_ERROR"));
  } finally { f.cleanup(); }
});

test("audio QC: FAIL with DURATION_SHORT when AIFF is much shorter than expected", async () => {
  // 44100 frames at 44100 Hz = 1 second, but expected is 5 seconds (ratio 0.2 < 0.8)
  const f = await makeFixture({
    aiffAmplitude: 0.5,
    aiffSampleRate: 44100,
    aiffFrames: 44100,   // 1 second
    audioDuration: 5,     // expected 5 seconds
  });
  try {
    const track = { ...NARRATION_TRACK, path: f.aiffPath, durationSeconds: 5, endSeconds: 5 };
    const result = await checkAudioAsset("SH_001", track, "", DEFAULT_QC_THRESHOLDS);
    assert.ok(result.reasons.includes("DURATION_SHORT"), `expected DURATION_SHORT in ${result.reasons}`);
    assert.equal(result.status, "FAIL");
  } finally { f.cleanup(); }
});

test("audio QC: PASS with no audio track (silent shot)", async () => {
  const result = await checkAudioAsset("SH_001", undefined, "", DEFAULT_QC_THRESHOLDS);
  assert.equal(result.status, "PASS");
  assert.equal(result.reasons.length, 0);
});

// ---------------------------------------------------------------------------
// Episode QC tests
// ---------------------------------------------------------------------------

test("runEpisodeQC: PASS for a clean episode with valid assets", async () => {
  const f = await makeFixture({ pngR: 128, pngG: 128, pngB: 128, aiffAmplitude: 0.5 });
  try {
    // Use absolute paths so assetRoot can be empty
    const comp = makeComposition({ pngPath: f.pngPath, aiffPath: f.aiffPath });
    const report = await runEpisodeQC(comp);
    assert.equal(report.status, "PASS");
    assert.equal(report.totalShots, 1);
    assert.equal(report.passedShots, 1);
    assert.equal(report.failedShots, 0);
    assert.equal(report.episodeId, "EP_QC_001");
    assert.equal(report.compositionVersion, 1);
    assert.ok(report.checkedAt);
  } finally { f.cleanup(); }
});

test("runEpisodeQC: FAIL when visual asset is black frame", async () => {
  const f = await makeFixture({ pngR: 0, pngG: 0, pngB: 0, aiffAmplitude: 0.5 });
  try {
    const comp = makeComposition({ pngPath: f.pngPath, aiffPath: f.aiffPath });
    const report = await runEpisodeQC(comp);
    assert.equal(report.status, "FAIL");
    assert.equal(report.failedShots, 1);
    assert.ok(report.shots[0].visual.reasons.includes("BLACK_FRAME"));
  } finally { f.cleanup(); }
});

test("runEpisodeQC: FAIL when audio is silent", async () => {
  const f = await makeFixture({ pngR: 128, pngG: 128, pngB: 128, aiffAmplitude: 0 });
  try {
    const comp = makeComposition({ pngPath: f.pngPath, aiffPath: f.aiffPath });
    const report = await runEpisodeQC(comp);
    assert.equal(report.status, "FAIL");
    assert.ok(report.shots[0].audio.reasons.includes("FULL_SILENCE"));
  } finally { f.cleanup(); }
});

test("runEpisodeQC: checkedAt is not part of deterministic results", async () => {
  const f = await makeFixture();
  try {
    const comp = makeComposition({ pngPath: f.pngPath, aiffPath: f.aiffPath });
    const t1 = new Date("2026-09-26T10:00:00Z");
    const t2 = new Date("2026-09-26T11:00:00Z");
    const r1 = await runEpisodeQC(comp, { checkedAt: t1 });
    const r2 = await runEpisodeQC(comp, { checkedAt: t2 });
    assert.notEqual(r1.checkedAt, r2.checkedAt);
    assert.equal(r1.status, r2.status);
    assert.equal(r1.totalShots, r2.totalShots);
    assert.deepEqual(r1.shots.map(s => s.status), r2.shots.map(s => s.status));
  } finally { f.cleanup(); }
});

test("runEpisodeQC: throws for null composition", async () => {
  await assert.rejects(
    () => runEpisodeQC(null as any),
    /composition must be/
  );
});

test("runEpisodeQC: throws for composition missing episodeId", async () => {
  const bad = makeComposition();
  (bad as any).episodeId = "";
  await assert.rejects(
    () => runEpisodeQC(bad),
    /episodeId/
  );
});

test("runEpisodeQC: counts passedShots / warnedShots / failedShots correctly", async () => {
  // Single shot that is near-black (WARN)
  const f = await makeFixture({ pngR: 10, pngG: 10, pngB: 10, aiffAmplitude: 0.5 });
  try {
    const comp = makeComposition({ pngPath: f.pngPath, aiffPath: f.aiffPath });
    const report = await runEpisodeQC(comp);
    assert.equal(report.warnedShots, 1);
    assert.equal(report.passedShots, 0);
    assert.equal(report.failedShots, 0);
    assert.equal(report.status, "WARN");
  } finally { f.cleanup(); }
});
