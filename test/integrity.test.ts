/**
 * V0.8 Phase 1 — Asset Integrity Regression Tests
 *
 * All tests use real temporary files and compute real SHA-256 hashes.
 * Audio duration verification is intentionally NOT tested here
 * (deferred to Phase 3 / FFprobe).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyAssetIntegrity } from "../src/integrity.ts";
import type { AudioAssetManifest, AssetManifest, FinalCompositionSpec } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Minimal valid binary fixtures (not real PNG/AIFF, just files with the right extension)
// Real SHA-256s are computed from actual bytes — no fake hashes.
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080200000090" +
  "7753de0000000c4944415408d763f8cfc00000000200019e221bc3300000" +
  "000049454e44ae426082", "hex"
);

const AIFF_BYTES = Buffer.from(
  "464f524d000000264149464600000016434f4d4d00010002000100000" +
  "5dc00104d41524b0000000800000000000000005353" +
  "4e44000000080000000000000000", "hex"
);

function sha256buf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  pngRelative: string;
  aiffRelative: string;
  pngSha256: string;
  aiffSha256: string;
  pngByteLength: number;
  aiffByteLength: number;
  composition: FinalCompositionSpec;
  audioManifest: AudioAssetManifest;
  assetManifest: AssetManifest;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "yt-pipe-integrity-"));
  mkdirSync(join(root, "assets"), { recursive: true });

  const pngRelative = "assets/shot1.png";
  const aiffRelative = "assets/seg1.aiff";
  writeFileSync(join(root, pngRelative), PNG_BYTES);
  writeFileSync(join(root, aiffRelative), AIFF_BYTES);

  const pngSha256 = sha256buf(PNG_BYTES);
  const aiffSha256 = sha256buf(AIFF_BYTES);
  const pngByteLength = PNG_BYTES.byteLength;
  const aiffByteLength = AIFF_BYTES.byteLength;

  const assetManifest: AssetManifest = {
    schemaVersion: "0.1",
    manifestRevision: 1,
    episodeId: "EP_001",
    sourceSpecVersion: 1,
    sourceVisualSpecVersion: 1,
    generatedAt: "2026-09-25T00:00:00.000Z",
    assets: [{
      id: "VAS_SH_001",
      shotId: "SH_001",
      shotVisualSpecId: "VSS_SH_001",
      activeVersionId: "VAS_SH_001_v1",
      versions: [{
        id: "VAS_SH_001_v1",
        version: 1,
        lifecycle: "GENERATED",
        createdAt: "2026-09-25T00:00:00.000Z",
        output: { path: pngRelative, format: "png", byteLength: pngByteLength, sha256: pngSha256 }
      }]
    }]
  };

  const audioManifest: AudioAssetManifest = {
    schemaVersion: "0.1",
    episodeId: "EP_001",
    sourceSpecVersion: 1,
    generatedAt: "2026-09-25T00:00:00.000Z",
    provider: "macos-say",
    assets: [{
      id: "AST_1",
      segmentId: "SEG_1",
      shotId: "SH_001",
      role: "narration",
      voice: "Narrator",
      path: aiffRelative,
      format: "aiff",
      durationSeconds: 2,
    }]
  };

  const composition: FinalCompositionSpec = {
    schemaVersion: "0.1",
    compositionVersion: 1,
    episodeId: "EP_001",
    sourceSpecVersion: 1,
    sourceTimelineVersion: 1,
    sourceMotionPlanVersion: 1,
    sourceVisualSpecVersion: 1,
    sourceAssetManifestRevision: 1,
    generatedAt: "2026-09-25T00:00:00.000Z",
    durationSeconds: 2,
    visualComposition: {
      canvas: { width: 1920, height: 1080, frameRate: 24 },
      shots: [{
        id: "MCP_SH_001",
        sceneId: "SC_001",
        shotId: "SH_001",
        visualAsset: { assetId: "VAS_SH_001", assetVersionId: "VAS_SH_001_v1", path: pngRelative, sha256: pngSha256 },
        timing: { startSeconds: 0, endSeconds: 2, durationSeconds: 2 },
        camera: { intent: "slow push-in", keyframes: [{ offset: 0, scale: 1, x: 0.5, y: 0.5 }, { offset: 1, scale: 1.08, x: 0.5, y: 0.5 }] },
        sourceHash: "a".repeat(64),
      }]
    },
    narrationDialogueTracks: [{
      id: "MIX_SEG_1",
      audioAssetId: "AST_1",
      path: aiffRelative,
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
    captions: [{ id: "CAP_SEG_1", role: "narration", text: "Hello.", startSeconds: 0, endSeconds: 2 }],
    sourceHash: "b".repeat(64),
  };

  return {
    root, pngRelative, aiffRelative, pngSha256, aiffSha256, pngByteLength, aiffByteLength,
    composition, audioManifest, assetManifest,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("reports OK for a valid, fully-matching asset set", async () => {
  const f = makeFixture();
  try {
    const report = await verifyAssetIntegrity(f.composition, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "OK");
    assert.equal(report.failures.length, 0);
    assert.equal(report.assets.length, 2);
    assert.equal(report.episodeId, "EP_001");
    assert.equal(report.compositionVersion, 1);
    // Visual asset: full verification
    const visual = report.assets.find(a => a.kind === "visual")!;
    assert.equal(visual.status, "OK");
    assert.equal((visual as any).expectedSha256, f.pngSha256);
    assert.equal((visual as any).actualSha256, f.pngSha256);
    // Audio asset: existence and format only
    const audio = report.assets.find(a => a.kind === "audio")!;
    assert.equal(audio.status, "OK");
    assert.ok(typeof (audio as any).actualSha256 === "string", "audio SHA-256 should be computed and recorded");
  } finally { f.cleanup(); }
});

test("checkedAt is execution metadata — not factored into deterministic results", async () => {
  const f = makeFixture();
  try {
    const t1 = new Date("2026-09-25T10:00:00.000Z");
    const t2 = new Date("2026-09-25T11:00:00.000Z");
    const r1 = await verifyAssetIntegrity(f.composition, f.audioManifest, f.assetManifest, f.root, { checkedAt: t1 });
    const r2 = await verifyAssetIntegrity(f.composition, f.audioManifest, f.assetManifest, f.root, { checkedAt: t2 });
    assert.notEqual(r1.checkedAt, r2.checkedAt);
    // Deterministic results are identical despite different checkedAt
    assert.equal(r1.status, r2.status);
    assert.deepEqual(r1.assets, r2.assets);
    assert.deepEqual(r1.failures, r2.failures);
  } finally { f.cleanup(); }
});

test("reports MISSING for a missing visual asset", async () => {
  const f = makeFixture();
  try {
    const { rmSync: rm } = await import("node:fs");
    rm(join(f.root, f.pngRelative));
    const report = await verifyAssetIntegrity(f.composition, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const visual = report.failures.find(a => a.kind === "visual");
    assert.ok(visual, "should have a visual failure");
    assert.equal(visual!.status, "MISSING");
  } finally { f.cleanup(); }
});

test("reports MISSING for a missing audio asset", async () => {
  const f = makeFixture();
  try {
    const { rmSync: rm } = await import("node:fs");
    rm(join(f.root, f.aiffRelative));
    const report = await verifyAssetIntegrity(f.composition, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const audio = report.failures.find(a => a.kind === "audio");
    assert.ok(audio, "should have an audio failure");
    assert.equal(audio!.status, "MISSING");
  } finally { f.cleanup(); }
});

test("reports HASH_MISMATCH when visual asset has been modified on disk", async () => {
  const f = makeFixture();
  try {
    // Overwrite with different content — same length to distinguish from BYTE_LENGTH_MISMATCH
    const modified = Buffer.from(PNG_BYTES);
    modified[modified.length - 1] ^= 0xff;
    writeFileSync(join(f.root, f.pngRelative), modified);
    const report = await verifyAssetIntegrity(f.composition, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const visual = report.failures.find(a => a.kind === "visual");
    assert.ok(visual);
    assert.equal(visual!.status, "HASH_MISMATCH");
    assert.equal((visual as any).expectedSha256, f.pngSha256);
    assert.notEqual((visual as any).actualSha256, f.pngSha256);
  } finally { f.cleanup(); }
});

test("reports BYTE_LENGTH_MISMATCH when visual asset is a different size", async () => {
  const f = makeFixture();
  try {
    // Write more bytes — different byteLength triggers BYTE_LENGTH_MISMATCH before SHA-256 check
    writeFileSync(join(f.root, f.pngRelative), Buffer.concat([PNG_BYTES, Buffer.from([0x00, 0x01])]));
    const report = await verifyAssetIntegrity(f.composition, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const visual = report.failures.find(a => a.kind === "visual");
    assert.ok(visual);
    assert.equal(visual!.status, "BYTE_LENGTH_MISMATCH");
  } finally { f.cleanup(); }
});

test("reports MANIFEST_REFERENCE_MISMATCH when composition sha256 disagrees with AssetManifest", async () => {
  const f = makeFixture();
  try {
    const tampered = structuredClone(f.composition);
    tampered.visualComposition.shots[0].visualAsset.sha256 = "0".repeat(64);
    const report = await verifyAssetIntegrity(tampered, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const visual = report.failures.find(a => a.kind === "visual");
    assert.ok(visual);
    assert.equal(visual!.status, "MANIFEST_REFERENCE_MISMATCH");
  } finally { f.cleanup(); }
});

test("reports MANIFEST_REFERENCE_MISMATCH when composition path disagrees with AssetManifest", async () => {
  const f = makeFixture();
  try {
    const tampered = structuredClone(f.composition);
    tampered.visualComposition.shots[0].visualAsset.path = "assets/wrong.png";
    const report = await verifyAssetIntegrity(tampered, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const visual = report.failures.find(a => a.kind === "visual");
    assert.ok(visual);
    assert.equal(visual!.status, "MANIFEST_REFERENCE_MISMATCH");
  } finally { f.cleanup(); }
});

test("reports MANIFEST_REFERENCE_MISMATCH when composition references an unknown assetId", async () => {
  const f = makeFixture();
  try {
    const tampered = structuredClone(f.composition);
    tampered.visualComposition.shots[0].visualAsset.assetId = "VAS_NONEXISTENT";
    const report = await verifyAssetIntegrity(tampered, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const visual = report.failures.find(a => a.kind === "visual");
    assert.ok(visual);
    assert.equal(visual!.status, "MANIFEST_REFERENCE_MISMATCH");
  } finally { f.cleanup(); }
});

test("reports MANIFEST_REFERENCE_MISMATCH when audio path in composition disagrees with AudioAssetManifest", async () => {
  const f = makeFixture();
  try {
    const tampered = structuredClone(f.composition);
    tampered.narrationDialogueTracks[0].path = "assets/wrong.aiff";
    const report = await verifyAssetIntegrity(tampered, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const audio = report.failures.find(a => a.kind === "audio");
    assert.ok(audio);
    assert.equal(audio!.status, "MANIFEST_REFERENCE_MISMATCH");
  } finally { f.cleanup(); }
});

test("reports MANIFEST_REFERENCE_MISMATCH when audio durationSeconds in composition disagrees", async () => {
  const f = makeFixture();
  try {
    const tampered = structuredClone(f.composition);
    tampered.narrationDialogueTracks[0].durationSeconds = 99;
    const report = await verifyAssetIntegrity(tampered, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const audio = report.failures.find(a => a.kind === "audio");
    assert.ok(audio);
    assert.equal(audio!.status, "MANIFEST_REFERENCE_MISMATCH");
  } finally { f.cleanup(); }
});

test("reports FORMAT_MISMATCH for a visual asset with wrong extension", async () => {
  const f = makeFixture();
  try {
    // Put same content at a .jpg path, update only the manifest
    const wrongManifest = structuredClone(f.assetManifest);
    wrongManifest.assets[0].versions[0].output!.path = "assets/shot1.jpg";
    const wrongComp = structuredClone(f.composition);
    wrongComp.visualComposition.shots[0].visualAsset.path = "assets/shot1.jpg";
    // Write file at wrong path
    writeFileSync(join(f.root, "assets/shot1.jpg"), PNG_BYTES);
    // Recompute sha256 (same bytes so same hash), reuse pngSha256
    const report = await verifyAssetIntegrity(wrongComp, f.audioManifest, wrongManifest, f.root);
    assert.equal(report.status, "FAILED");
    const visual = report.failures.find(a => a.kind === "visual");
    assert.ok(visual);
    assert.equal(visual!.status, "FORMAT_MISMATCH");
  } finally { f.cleanup(); }
});

test("reports FORMAT_MISMATCH for an audio asset with wrong extension", async () => {
  const f = makeFixture();
  try {
    const wrongAudioManifest = structuredClone(f.audioManifest);
    (wrongAudioManifest.assets[0] as any).format = "mp3";
    // AudioAssetManifest type only allows "aiff", but we're testing boundary enforcement
    const wrongComp = structuredClone(f.composition);
    (wrongComp.narrationDialogueTracks[0] as any).format = "mp3";
    wrongComp.narrationDialogueTracks[0].path = "assets/seg1.mp3";
    wrongAudioManifest.assets[0].path = "assets/seg1.mp3";
    writeFileSync(join(f.root, "assets/seg1.mp3"), AIFF_BYTES);
    const report = await verifyAssetIntegrity(wrongComp, wrongAudioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const audio = report.failures.find(a => a.kind === "audio");
    assert.ok(audio);
    assert.equal(audio!.status, "FORMAT_MISMATCH");
  } finally { f.cleanup(); }
});

test("reports PATH_VIOLATION for a visual asset path that escapes assetRoot", async () => {
  const f = makeFixture();
  try {
    const malicious = "../../etc/passwd";
    const tampered = structuredClone(f.composition);
    tampered.visualComposition.shots[0].visualAsset.path = malicious;
    // Manifest also needs to agree on path (Layer 1) — set it to escape as well
    const tamperedManifest = structuredClone(f.assetManifest);
    tamperedManifest.assets[0].versions[0].output!.path = malicious;
    const report = await verifyAssetIntegrity(tampered, f.audioManifest, tamperedManifest, f.root);
    assert.equal(report.status, "FAILED");
    const visual = report.failures.find(a => a.kind === "visual");
    assert.ok(visual);
    assert.equal(visual!.status, "PATH_VIOLATION");
  } finally { f.cleanup(); }
});

test("reports PATH_VIOLATION for an audio asset path that escapes assetRoot", async () => {
  const f = makeFixture();
  try {
    const malicious = "../../etc/shadow";
    const tamperedComp = structuredClone(f.composition);
    tamperedComp.narrationDialogueTracks[0].path = malicious;
    const tamperedAudio = structuredClone(f.audioManifest);
    tamperedAudio.assets[0].path = malicious;
    const report = await verifyAssetIntegrity(tamperedComp, tamperedAudio, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    const audio = report.failures.find(a => a.kind === "audio");
    assert.ok(audio);
    assert.equal(audio!.status, "PATH_VIOLATION");
  } finally { f.cleanup(); }
});

test("throws for a malformed FinalCompositionSpec (not a valid object)", async () => {
  const f = makeFixture();
  try {
    await assert.rejects(
      () => verifyAssetIntegrity(null as any, f.audioManifest, f.assetManifest, f.root),
      /FinalCompositionSpec/
    );
  } finally { f.cleanup(); }
});

test("throws for a malformed AudioAssetManifest (missing assets array)", async () => {
  const f = makeFixture();
  try {
    await assert.rejects(
      () => verifyAssetIntegrity(f.composition, {} as any, f.assetManifest, f.root),
      /AudioAssetManifest/
    );
  } finally { f.cleanup(); }
});

test("throws for an empty assetRoot", async () => {
  const f = makeFixture();
  try {
    await assert.rejects(
      () => verifyAssetIntegrity(f.composition, f.audioManifest, f.assetManifest, ""),
      /assetRoot/
    );
  } finally { f.cleanup(); }
});

test("accumulates multiple failures — does not stop at first", async () => {
  const f = makeFixture();
  try {
    const { rmSync: rm } = await import("node:fs");
    rm(join(f.root, f.pngRelative));
    rm(join(f.root, f.aiffRelative));
    const report = await verifyAssetIntegrity(f.composition, f.audioManifest, f.assetManifest, f.root);
    assert.equal(report.status, "FAILED");
    assert.equal(report.failures.length, 2, "both visual and audio failures should be collected");
  } finally { f.cleanup(); }
});
