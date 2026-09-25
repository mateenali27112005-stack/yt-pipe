/**
 * V0.7 Shot Repair Agent — Deterministic Tests
 *
 * Tests cover:
 *   1. decideRepairs() — pure decision function
 *   2. executeRepairs() — with stub repairers (no real providers)
 *
 * No network. No real image or TTS providers. No FFmpeg.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeflate } from "node:zlib";
import { Readable } from "node:stream";
import test from "node:test";

import { decideRepairs, executeRepairs } from "../src/repair.ts";
import type { ShotVisualRepairer, ShotAudioRepairer } from "../src/repair.ts";
import type { EpisodeQCReport, ShotQCResult } from "../src/qc-types.ts";
import type { FinalCompositionSpec } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Minimal PNG/AIFF builders (duplicated from qc.test.ts for isolation)
// ---------------------------------------------------------------------------

function crc32(data: Buffer): number {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
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

async function buildPNG(r = 128, g = 128, b = 128): Promise<Buffer> {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(4, 0); ihdrData.writeUInt32BE(4, 4);
  ihdrData[8] = 8; ihdrData[9] = 2; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  const raw = Buffer.alloc(4 * (1 + 4 * 3));
  for (let y = 0; y < 4; y++) {
    raw[y * (1 + 12)] = 0;
    for (let x = 0; x < 4; x++) {
      raw[y * 13 + 1 + x * 3] = r;
      raw[y * 13 + 2 + x * 3] = g;
      raw[y * 13 + 3 + x * 3] = b;
    }
  }
  const compressed = await new Promise<Buffer>((res, rej) => {
    const d = createDeflate({ level: 1 });
    const chunks: Buffer[] = [];
    d.on("data", (c: Buffer) => chunks.push(c));
    d.on("end", () => res(Buffer.concat(chunks)));
    d.on("error", rej);
    Readable.from(raw).pipe(d);
  });
  return Buffer.concat([PNG_SIG, makePNGChunk("IHDR", ihdrData), makePNGChunk("IDAT", compressed), makePNGChunk("IEND", Buffer.alloc(0))]);
}

function ieee80ForRate(sampleRate: number): Buffer {
  // Encode sample rate as 80-bit IEEE 754 extended precision.
  // Target [2^31, 2^32) normalisation range to avoid overflow.
  const buf = Buffer.alloc(10);
  let exp = 16383 + 31; // bias + 31 (target [2^31, 2^32))
  let m = sampleRate;
  while (m < 0x80000000) { m *= 2; exp--; }
  const mHigh = Math.floor(m) >>> 0;
  buf.writeUInt16BE(exp & 0x7fff, 0);
  buf.writeUInt32BE(mHigh, 2);
  buf.writeUInt32BE(0, 6); // low 32 bits are always 0 for integer rates
  return buf;
}

/** AIFF chunk: [type:4][size:4][data] — no CRC, no leading size. */
function makeAIFFChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

function buildAIFF(amplitude = 0.5, frames = 88200): Buffer {
  const numChannels = 1;
  const sampleRate = 44100;
  const sampleSize = 16;
  const commData = Buffer.alloc(18);
  commData.writeInt16BE(numChannels, 0);
  commData.writeUInt32BE(frames, 2);
  commData.writeInt16BE(sampleSize, 6);
  ieee80ForRate(sampleRate).copy(commData, 8);
  const pcm = Buffer.alloc(frames * 2);
  const val = Math.round(amplitude * 32767);
  for (let i = 0; i < frames; i++) pcm.writeInt16BE(val, i * 2);
  const ssndData = Buffer.concat([Buffer.alloc(8), pcm]);
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
// Stub QC report builder
// ---------------------------------------------------------------------------

function makeQCReport(
  shotResults: Array<{ shotId: string; visualReasons: string[]; audioReasons: string[] }>
): EpisodeQCReport {
  const shots: ShotQCResult[] = shotResults.map(({ shotId, visualReasons, audioReasons }) => {
    const VISUAL_FAIL = new Set(["BLACK_FRAME", "WRONG_DIMENSIONS", "FORMAT_ERROR", "MISSING_FILE"]);
    const AUDIO_FAIL = new Set(["FULL_SILENCE", "DURATION_SHORT", "FORMAT_ERROR", "MISSING_FILE"]);
    const visualStatus = visualReasons.some(r => VISUAL_FAIL.has(r)) ? "FAIL" :
                         visualReasons.length > 0 ? "WARN" : "PASS";
    const audioStatus = audioReasons.some(r => AUDIO_FAIL.has(r)) ? "FAIL" :
                        audioReasons.length > 0 ? "WARN" : "PASS";
    const status = visualStatus === "FAIL" || audioStatus === "FAIL" ? "FAIL" :
                   visualStatus === "WARN" || audioStatus === "WARN" ? "WARN" : "PASS";
    return {
      shotId,
      status,
      visual: {
        shotId, assetId: `VAS_${shotId}`, assetVersionId: "v1",
        status: visualStatus, reasons: visualReasons as any,
        expectedWidth: 4, expectedHeight: 4,
      },
      audio: {
        shotId, assetId: `AST_${shotId}`, status: audioStatus,
        reasons: audioReasons as any, expectedDurationSeconds: 2,
      },
    };
  });

  const failed = shots.filter(s => s.status === "FAIL").length;
  const warned = shots.filter(s => s.status === "WARN").length;
  const passed = shots.filter(s => s.status === "PASS").length;

  return {
    schemaVersion: "0.1",
    episodeId: "EP_001",
    compositionVersion: 1,
    checkedAt: "2026-09-26T00:00:00Z",
    status: failed > 0 ? "FAIL" : warned > 0 ? "WARN" : "PASS",
    totalShots: shots.length,
    passedShots: passed,
    warnedShots: warned,
    failedShots: failed,
    shots,
  };
}

// ---------------------------------------------------------------------------
// decideRepairs tests
// ---------------------------------------------------------------------------

test("decideRepairs: returns empty array for an all-PASS episode", () => {
  const report = makeQCReport([{ shotId: "SH_001", visualReasons: [], audioReasons: [] }]);
  const decisions = decideRepairs(report);
  assert.equal(decisions.length, 0);
});

test("decideRepairs: RETRY_VISUAL for BLACK_FRAME", () => {
  const report = makeQCReport([{ shotId: "SH_001", visualReasons: ["BLACK_FRAME"], audioReasons: [] }]);
  const decisions = decideRepairs(report);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "RETRY_VISUAL");
  assert.ok(decisions[0].visualReasons.includes("BLACK_FRAME"));
  assert.equal(decisions[0].shotId, "SH_001");
});

test("decideRepairs: RETRY_AUDIO for FULL_SILENCE", () => {
  const report = makeQCReport([{ shotId: "SH_001", visualReasons: [], audioReasons: ["FULL_SILENCE"] }]);
  const decisions = decideRepairs(report);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "RETRY_AUDIO");
  assert.ok(decisions[0].audioReasons.includes("FULL_SILENCE"));
});

test("decideRepairs: RETRY_BOTH when both visual and audio fail", () => {
  const report = makeQCReport([{
    shotId: "SH_001",
    visualReasons: ["BLACK_FRAME"],
    audioReasons: ["FULL_SILENCE"]
  }]);
  const decisions = decideRepairs(report);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "RETRY_BOTH");
});

test("decideRepairs: SKIP for WARN-only shots", () => {
  const report = makeQCReport([{
    shotId: "SH_001",
    visualReasons: ["NEAR_BLACK_FRAME"],
    audioReasons: []
  }]);
  const decisions = decideRepairs(report);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "SKIP");
});

test("decideRepairs: ESCALATE for OVERSATURATED", () => {
  const report = makeQCReport([{
    shotId: "SH_001",
    visualReasons: ["OVERSATURATED"],
    audioReasons: []
  }]);
  const decisions = decideRepairs(report);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "ESCALATE");
});

test("decideRepairs: RETRY_VISUAL for WRONG_DIMENSIONS", () => {
  const report = makeQCReport([{ shotId: "SH_001", visualReasons: ["WRONG_DIMENSIONS"], audioReasons: [] }]);
  const decisions = decideRepairs(report);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "RETRY_VISUAL");
});

test("decideRepairs: RETRY_AUDIO for DURATION_SHORT", () => {
  const report = makeQCReport([{ shotId: "SH_001", visualReasons: [], audioReasons: ["DURATION_SHORT"] }]);
  const decisions = decideRepairs(report);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "RETRY_AUDIO");
});

test("decideRepairs: each decision has a non-empty rationale", () => {
  const report = makeQCReport([
    { shotId: "SH_001", visualReasons: ["BLACK_FRAME"], audioReasons: [] },
    { shotId: "SH_002", visualReasons: [], audioReasons: ["FULL_SILENCE"] },
    { shotId: "SH_003", visualReasons: ["NEAR_BLACK_FRAME"], audioReasons: [] },
  ]);
  const decisions = decideRepairs(report);
  assert.equal(decisions.length, 3);
  for (const d of decisions) {
    assert.ok(d.rationale.length > 0, `rationale missing for ${d.shotId}`);
  }
});

test("decideRepairs: handles multiple failing shots independently", () => {
  const report = makeQCReport([
    { shotId: "SH_001", visualReasons: ["BLACK_FRAME"], audioReasons: [] },
    { shotId: "SH_002", visualReasons: [], audioReasons: ["FULL_SILENCE"] },
    { shotId: "SH_003", visualReasons: [], audioReasons: [] }, // PASS
  ]);
  const decisions = decideRepairs(report);
  assert.equal(decisions.length, 2);
  const s1 = decisions.find(d => d.shotId === "SH_001");
  const s2 = decisions.find(d => d.shotId === "SH_002");
  assert.ok(s1); assert.equal(s1!.action, "RETRY_VISUAL");
  assert.ok(s2); assert.equal(s2!.action, "RETRY_AUDIO");
});

// ---------------------------------------------------------------------------
// executeRepairs tests
// ---------------------------------------------------------------------------

function makeComposition(pngPath: string, aiffPath: string): FinalCompositionSpec {
  return {
    schemaVersion: "0.1",
    compositionVersion: 1,
    episodeId: "EP_001",
    sourceSpecVersion: 1,
    sourceTimelineVersion: 1,
    sourceMotionPlanVersion: 1,
    sourceVisualSpecVersion: 1,
    sourceAssetManifestRevision: 1,
    generatedAt: "2026-09-26T00:00:00Z",
    durationSeconds: 2,
    visualComposition: {
      canvas: { width: 4, height: 4, frameRate: 24 },
      shots: [{
        id: "MCP_SH_001",
        sceneId: "SC_001",
        shotId: "SH_001",
        visualAsset: { assetId: "VAS_SH_001", assetVersionId: "v1", path: pngPath, sha256: "a".repeat(64) },
        timing: { startSeconds: 0, endSeconds: 2, durationSeconds: 2 },
        camera: { intent: "static", keyframes: [{ offset: 0, scale: 1, x: 0.5, y: 0.5 }] },
        sourceHash: "b".repeat(64),
      }],
    },
    narrationDialogueTracks: [{
      id: "MIX_SH_001",
      audioAssetId: "AST_SH_001",
      path: aiffPath,
      role: "narration",
      startSeconds: 0,
      endSeconds: 2,
      gainDb: 0,
      format: "aiff",
      durationSeconds: 2,
      voice: "Narrator",
    }],
    musicCues: [],
    sfxCues: [],
    captions: [],
    sourceHash: "c".repeat(64),
  };
}

test("executeRepairs: SKIPPED outcome for SKIP decision", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "yt-repair-"));
  try {
    const pngPath = join(tmp, "shot.png");
    const aiffPath = join(tmp, "narration.aiff");
    writeFileSync(pngPath, await buildPNG(128, 128, 128));
    writeFileSync(aiffPath, buildAIFF(0.5));
    const composition = makeComposition(pngPath, aiffPath);

    const decision = {
      shotId: "SH_001",
      action: "SKIP" as const,
      rationale: "Warn only",
      visualReasons: ["NEAR_BLACK_FRAME" as const],
      audioReasons: [],
    };

    const report = await executeRepairs([decision], { composition, repairedAt: new Date("2026-09-26T00:00:00Z") });
    assert.equal(report.results[0].outcome, "SKIPPED");
    assert.equal(report.skipped, 1);
    assert.equal(report.status, "CLEAN");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("executeRepairs: ESCALATED outcome for ESCALATE decision", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "yt-repair-"));
  try {
    const pngPath = join(tmp, "shot.png");
    const aiffPath = join(tmp, "narration.aiff");
    writeFileSync(pngPath, await buildPNG(128, 128, 128));
    writeFileSync(aiffPath, buildAIFF(0.5));
    const composition = makeComposition(pngPath, aiffPath);

    const decision = {
      shotId: "SH_001",
      action: "ESCALATE" as const,
      rationale: "Aesthetic failure",
      visualReasons: ["OVERSATURATED" as const],
      audioReasons: [],
    };

    const report = await executeRepairs([decision], { composition, repairedAt: new Date("2026-09-26T00:00:00Z") });
    assert.equal(report.results[0].outcome, "ESCALATED");
    assert.equal(report.escalated, 1);
    assert.equal(report.status, "NEEDS_REVIEW");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("executeRepairs: REPAIRED outcome when stub visual repairer fixes the shot", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "yt-repair-"));
  try {
    const pngPath = join(tmp, "shot.png");
    const aiffPath = join(tmp, "narration.aiff");
    // Write a black PNG initially (would fail QC)
    writeFileSync(pngPath, await buildPNG(0, 0, 0));
    writeFileSync(aiffPath, buildAIFF(0.5));
    const composition = makeComposition(pngPath, aiffPath);

    // Stub visual repairer: overwrites the PNG with a bright image
    const visualRepairer: ShotVisualRepairer = {
      async repairVisual(_shotId, assetPath) {
        const fixed = await buildPNG(128, 128, 128);
        writeFileSync(assetPath, fixed);
        return { sha256: "fixed".repeat(12).slice(0, 64), byteLength: fixed.length };
      }
    };

    const decision = {
      shotId: "SH_001",
      action: "RETRY_VISUAL" as const,
      rationale: "Black frame detected",
      visualReasons: ["BLACK_FRAME" as const],
      audioReasons: [],
    };

    const report = await executeRepairs([decision], {
      composition,
      visualRepairer,
      repairedAt: new Date("2026-09-26T00:00:00Z"),
    });

    assert.equal(report.results[0].outcome, "REPAIRED");
    assert.equal(report.repaired, 1);
    assert.equal(report.status, "CLEAN");
    assert.ok(report.results[0].postRepairQC, "postRepairQC should be populated");
    assert.ok(
      report.results[0].postRepairQC!.status !== "FAIL",
      `post-repair status should not be FAIL, got ${report.results[0].postRepairQC!.status}`
    );
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("executeRepairs: STILL_FAILING outcome when visual repairer does not fix the shot", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "yt-repair-"));
  try {
    const pngPath = join(tmp, "shot.png");
    const aiffPath = join(tmp, "narration.aiff");
    writeFileSync(pngPath, await buildPNG(0, 0, 0));
    writeFileSync(aiffPath, buildAIFF(0.5));
    const composition = makeComposition(pngPath, aiffPath);

    // Stub repairer that writes ANOTHER black frame — repair fails
    const visualRepairer: ShotVisualRepairer = {
      async repairVisual(_shotId, assetPath) {
        const still_black = await buildPNG(0, 0, 0);
        writeFileSync(assetPath, still_black);
        return { sha256: "0".repeat(64), byteLength: still_black.length };
      }
    };

    const decision = {
      shotId: "SH_001",
      action: "RETRY_VISUAL" as const,
      rationale: "Black frame",
      visualReasons: ["BLACK_FRAME" as const],
      audioReasons: [],
    };

    const report = await executeRepairs([decision], {
      composition,
      visualRepairer,
      repairedAt: new Date("2026-09-26T00:00:00Z"),
    });

    assert.equal(report.results[0].outcome, "STILL_FAILING");
    assert.equal(report.stillFailing, 1);
    assert.equal(report.status, "FAILED");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("executeRepairs: ERROR when no visualRepairer is provided for RETRY_VISUAL", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "yt-repair-"));
  try {
    const pngPath = join(tmp, "shot.png");
    const aiffPath = join(tmp, "narration.aiff");
    writeFileSync(pngPath, await buildPNG(0, 0, 0));
    writeFileSync(aiffPath, buildAIFF(0.5));
    const composition = makeComposition(pngPath, aiffPath);

    const decision = {
      shotId: "SH_001",
      action: "RETRY_VISUAL" as const,
      rationale: "Black frame",
      visualReasons: ["BLACK_FRAME" as const],
      audioReasons: [],
    };

    // No visualRepairer provided
    const report = await executeRepairs([decision], { composition });
    assert.equal(report.results[0].outcome, "ERROR");
    assert.ok(report.results[0].errorMessage?.includes("visualRepairer"));
    assert.equal(report.errors, 1);
    assert.equal(report.status, "FAILED");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("executeRepairs: REPAIRED when stub audio repairer fixes a silent track", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "yt-repair-"));
  try {
    const pngPath = join(tmp, "shot.png");
    const aiffPath = join(tmp, "narration.aiff");
    writeFileSync(pngPath, await buildPNG(128, 128, 128));
    // Write silent AIFF initially
    writeFileSync(aiffPath, buildAIFF(0));
    const composition = makeComposition(pngPath, aiffPath);

    const audioRepairer: ShotAudioRepairer = {
      async repairAudio(_shotId, audioPath, _text) {
        writeFileSync(audioPath, buildAIFF(0.5));
        return { durationSeconds: 2 };
      }
    };

    const decision = {
      shotId: "SH_001",
      action: "RETRY_AUDIO" as const,
      rationale: "Silent audio",
      visualReasons: [],
      audioReasons: ["FULL_SILENCE" as const],
    };

    const report = await executeRepairs([decision], {
      composition,
      audioRepairer,
      repairedAt: new Date("2026-09-26T00:00:00Z"),
    });

    assert.equal(report.results[0].outcome, "REPAIRED");
    assert.equal(report.repaired, 1);
    assert.equal(report.status, "CLEAN");
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test("executeRepairs: repairedAt is recorded on each result", async () => {
  const composition = makeComposition("/nonexistent.png", "/nonexistent.aiff");
  const decision = {
    shotId: "SH_001",
    action: "SKIP" as const,
    rationale: "Skip",
    visualReasons: [],
    audioReasons: [],
  };
  const repairedAt = new Date("2026-09-26T12:00:00Z");
  const report = await executeRepairs([decision], { composition, repairedAt });
  assert.equal(report.repairedAt, "2026-09-26T12:00:00.000Z");
  assert.equal(report.results[0].repairedAt, "2026-09-26T12:00:00.000Z");
});

test("executeRepairs: schema version and episodeId are correct", async () => {
  const composition = makeComposition("/nonexistent.png", "/nonexistent.aiff");
  const report = await executeRepairs([], { composition });
  assert.equal(report.schemaVersion, "0.1");
  assert.equal(report.episodeId, "EP_001");
});
