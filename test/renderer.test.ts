/**
 * V0.8 Phase 2 — Renderer Abstraction Tests
 *
 * These tests prove the renderer interface contract without FFmpeg.
 * A FakeRenderer is used — it lives ONLY in this test file.
 *
 * Tested:
 * 1. Renderer interface can consume a valid FinalCompositionSpec.
 * 2. Successful renderer returns a well-formed RenderResult.
 * 3. Failed rendering is represented deterministically.
 * 4. Renderer does not mutate FinalCompositionSpec.
 * 5. Renderer cannot proceed with a failed integrity report.
 * 6. Renderer cannot proceed with a missing integrity report.
 * 7. Renderer validates episodeId match between report and composition.
 * 8. Renderer validates compositionVersion match between report and composition.
 * 9. Output path validation.
 * 10. No fake duration is produced on failure.
 * 11. assertRenderPreconditions is enforceable independently.
 * 12. Phase 2 is completely FFmpeg-free.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRenderPreconditions,
  type Renderer,
  type RenderResult,
} from "../src/renderer.ts";
import { RenderError } from "../src/renderer-types.ts";
import type { RenderContext } from "../src/renderer-types.ts";
import type { FinalCompositionSpec } from "../src/types.ts";
import type { IntegrityReport } from "../src/integrity-types.ts";

// ---------------------------------------------------------------------------
// FakeRenderer — test-only implementation of Renderer
// ---------------------------------------------------------------------------

class FakeRenderer implements Renderer {
  readonly rendererVersion = "FakeRenderer/test";

  /** If set, the next render() call returns this failure instead of succeeding. */
  nextFailure?: string;

  async render(composition: FinalCompositionSpec, context: RenderContext): Promise<RenderResult> {
    // Every real renderer must call assertRenderPreconditions first.
    assertRenderPreconditions(composition, context);

    if (this.nextFailure) {
      const reason = this.nextFailure;
      this.nextFailure = undefined;
      return { status: "FAILED", reason };
    }

    // Fake: produce a deterministic result based on composition content.
    // Does NOT read any files. Does NOT invoke FFmpeg.
    // durationSeconds is NOT populated — the fake renderer cannot measure it.
    return {
      status: "OK",
      outputPath: context.outputPath,
      format: "mp4",
      byteLength: 12345,        // deterministic fake
      sha256: "c".repeat(64),   // deterministic fake
      rendererVersion: this.rendererVersion,
      // durationSeconds intentionally absent — fake renderer doesn't measure it
    };
  }
}

// ---------------------------------------------------------------------------
// Canonical valid fixtures
// ---------------------------------------------------------------------------

const VALID_COMPOSITION: FinalCompositionSpec = {
  schemaVersion: "0.1",
  compositionVersion: 1,
  episodeId: "EP_001",
  sourceSpecVersion: 1,
  sourceTimelineVersion: 1,
  sourceMotionPlanVersion: 1,
  sourceVisualSpecVersion: 1,
  sourceAssetManifestRevision: 1,
  generatedAt: "2026-09-25T00:00:00.000Z",
  durationSeconds: 3,
  visualComposition: {
    canvas: { width: 1920, height: 1080, frameRate: 24 },
    shots: [{
      id: "MCP_SH_001",
      sceneId: "SC_001",
      shotId: "SH_001",
      visualAsset: { assetId: "VAS_1", assetVersionId: "VAS_1_v1", path: "assets/shot1.png", sha256: "a".repeat(64) },
      timing: { startSeconds: 0, endSeconds: 3, durationSeconds: 3 },
      camera: { intent: "slow push-in", keyframes: [{ offset: 0, scale: 1, x: 0.5, y: 0.5 }, { offset: 1, scale: 1.08, x: 0.5, y: 0.5 }] },
      sourceHash: "b".repeat(64),
    }]
  },
  narrationDialogueTracks: [{
    id: "MIX_SEG_1",
    audioAssetId: "AST_1",
    path: "assets/seg1.aiff",
    role: "narration",
    startSeconds: 0,
    endSeconds: 3,
    gainDb: 0,
    format: "aiff",
    durationSeconds: 3,
    voice: "Narrator",
  }],
  musicCues: [],
  sfxCues: [],
  captions: [{ id: "CAP_1", role: "narration", text: "Hello.", startSeconds: 0, endSeconds: 3 }],
  sourceHash: "d".repeat(64),
};

const OK_INTEGRITY_REPORT: IntegrityReport = {
  status: "OK",
  episodeId: "EP_001",
  compositionVersion: 1,
  compositionSourceHash: "d".repeat(64),
  checkedAt: "2026-09-25T10:00:00.000Z",
  assets: [
    {
      kind: "visual",
      assetId: "VAS_1",
      assetVersionId: "VAS_1_v1",
      path: "assets/shot1.png",
      resolvedPath: "/tmp/assets/assets/shot1.png",
      status: "OK",
    },
    {
      kind: "audio",
      assetId: "AST_1",
      path: "assets/seg1.aiff",
      resolvedPath: "/tmp/assets/assets/seg1.aiff",
      status: "OK",
    },
  ],
  failures: [],
};

const VALID_CONTEXT: RenderContext = {
  assetRoot: "/tmp/assets",
  outputPath: "/tmp/output/episode.mp4",
  integrityReport: OK_INTEGRITY_REPORT,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("FakeRenderer returns a successful RenderResult for a valid composition", async () => {
  const renderer = new FakeRenderer();
  const result = await renderer.render(VALID_COMPOSITION, VALID_CONTEXT);
  assert.equal(result.status, "OK");
  if (result.status === "OK") {
    assert.equal(result.outputPath, VALID_CONTEXT.outputPath);
    assert.equal(result.format, "mp4");
    assert.equal(typeof result.byteLength, "number");
    assert.equal(typeof result.sha256, "string");
    assert.equal(result.sha256.length, 64);
    assert.equal(result.rendererVersion, "FakeRenderer/test");
    // Phase 2: fake renderer must NOT claim a duration it didn't measure
    assert.equal(result.durationSeconds, undefined,
      "Phase 2 renderer must not produce a fake durationSeconds");
  }
});

test("render() returns a deterministic RenderResult for the same inputs", async () => {
  const renderer = new FakeRenderer();
  const r1 = await renderer.render(VALID_COMPOSITION, VALID_CONTEXT);
  const r2 = await renderer.render(VALID_COMPOSITION, VALID_CONTEXT);
  assert.deepEqual(r1, r2);
});

test("renderer returns RenderFailure when encoding fails — not a thrown error", async () => {
  const renderer = new FakeRenderer();
  renderer.nextFailure = "Encoding process exited with code 1";
  const result = await renderer.render(VALID_COMPOSITION, VALID_CONTEXT);
  assert.equal(result.status, "FAILED");
  if (result.status === "FAILED") {
    assert.equal(result.reason, "Encoding process exited with code 1");
    // RenderFailure must NOT have outputPath, byteLength, or sha256
    assert.equal((result as any).outputPath, undefined);
    assert.equal((result as any).byteLength, undefined);
    assert.equal((result as any).sha256, undefined);
  }
});

test("renderer does not mutate FinalCompositionSpec", async () => {
  const renderer = new FakeRenderer();
  const original = JSON.stringify(VALID_COMPOSITION);
  await renderer.render(VALID_COMPOSITION, VALID_CONTEXT);
  assert.equal(JSON.stringify(VALID_COMPOSITION), original,
    "FinalCompositionSpec must not be mutated by render()");
});

test("throws RenderError when integrityReport is missing", async () => {
  const renderer = new FakeRenderer();
  const noReport = { ...VALID_CONTEXT, integrityReport: undefined as any };
  await assert.rejects(
    () => renderer.render(VALID_COMPOSITION, noReport),
    (err) => err instanceof RenderError && /integrityReport is required/.test(err.message)
  );
});

test("throws RenderError when integrityReport.status is FAILED", async () => {
  const renderer = new FakeRenderer();
  const failedReport: IntegrityReport = { ...OK_INTEGRITY_REPORT, status: "FAILED", failures: [] };
  const ctx = { ...VALID_CONTEXT, integrityReport: failedReport };
  await assert.rejects(
    () => renderer.render(VALID_COMPOSITION, ctx),
    (err) => err instanceof RenderError && /integrity report status is 'FAILED'/.test(err.message)
  );
});

test("throws RenderError when report episodeId does not match composition episodeId", async () => {
  const renderer = new FakeRenderer();
  const wrongEpisode: IntegrityReport = { ...OK_INTEGRITY_REPORT, episodeId: "EP_999" };
  const ctx = { ...VALID_CONTEXT, integrityReport: wrongEpisode };
  await assert.rejects(
    () => renderer.render(VALID_COMPOSITION, ctx),
    (err) => err instanceof RenderError && /episodeId/.test(err.message)
  );
});

test("throws RenderError when report compositionVersion does not match composition", async () => {
  const renderer = new FakeRenderer();
  const wrongVersion: IntegrityReport = { ...OK_INTEGRITY_REPORT, compositionVersion: 99 };
  const ctx = { ...VALID_CONTEXT, integrityReport: wrongVersion };
  await assert.rejects(
    () => renderer.render(VALID_COMPOSITION, ctx),
    (err) => err instanceof RenderError && /compositionVersion/.test(err.message)
  );
});

test("throws RenderError when outputPath is empty", async () => {
  const renderer = new FakeRenderer();
  const ctx = { ...VALID_CONTEXT, outputPath: "" };
  await assert.rejects(
    () => renderer.render(VALID_COMPOSITION, ctx),
    (err) => err instanceof RenderError && /outputPath/.test(err.message)
  );
});

test("throws RenderError when assetRoot is empty", async () => {
  const renderer = new FakeRenderer();
  const ctx = { ...VALID_CONTEXT, assetRoot: "" };
  await assert.rejects(
    () => renderer.render(VALID_COMPOSITION, ctx),
    (err) => err instanceof RenderError && /assetRoot/.test(err.message)
  );
});

test("throws RenderError for a malformed composition (missing episodeId)", async () => {
  const renderer = new FakeRenderer();
  const bad = { ...VALID_COMPOSITION, episodeId: "" };
  await assert.rejects(
    () => renderer.render(bad as any, VALID_CONTEXT),
    (err) => err instanceof RenderError && /FinalCompositionSpec/.test(err.message)
  );
});

test("throws RenderError for a null composition", async () => {
  const renderer = new FakeRenderer();
  await assert.rejects(
    () => renderer.render(null as any, VALID_CONTEXT),
    (err) => err instanceof RenderError
  );
});

test("assertRenderPreconditions is independently enforceable — passes for valid inputs", () => {
  assert.doesNotThrow(() => assertRenderPreconditions(VALID_COMPOSITION, VALID_CONTEXT));
});

test("assertRenderPreconditions throws RenderError for a null context", () => {
  assert.throws(
    () => assertRenderPreconditions(VALID_COMPOSITION, null),
    (err) => err instanceof RenderError && /RenderContext/.test(err.message)
  );
});

test("multiple renderer instances are independent — no shared state", async () => {
  const r1 = new FakeRenderer();
  const r2 = new FakeRenderer();
  r1.nextFailure = "r1 error";
  const result1 = await r1.render(VALID_COMPOSITION, VALID_CONTEXT);
  const result2 = await r2.render(VALID_COMPOSITION, VALID_CONTEXT);
  assert.equal(result1.status, "FAILED");
  assert.equal(result2.status, "OK");
});

test("Phase 2 has no FFmpeg dependency — no ffmpeg/ffprobe process invocations in renderer.ts or renderer-types.ts", async () => {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const rendererSrc = readFileSync(join(root, "src/renderer.ts"), "utf8");
  const typesSrc = readFileSync(join(root, "src/renderer-types.ts"), "utf8");
  // Allow references to "FFmpegRenderer" (Phase 3 class name in comments/docs)
  // but reject any actual process invocations or shell command strings
  assert.ok(!rendererSrc.includes("spawnSync"), "renderer.ts must not spawn processes");
  assert.ok(!rendererSrc.includes("execSync"), "renderer.ts must not exec processes");
  assert.ok(!/['"` ]ffmpeg[\s"'`]/.test(rendererSrc), "renderer.ts must not invoke the ffmpeg binary");
  assert.ok(!/['"` ]ffprobe[\s"'`]/.test(rendererSrc), "renderer.ts must not invoke the ffprobe binary");
  assert.ok(!typesSrc.includes("spawnSync"), "renderer-types.ts must not spawn processes");
  assert.ok(!/['"` ]ffmpeg[\s"'`]/.test(typesSrc), "renderer-types.ts must not invoke the ffmpeg binary");
});

test("throws RenderError when compositionSourceHash in report does not match composition", async () => {
  const renderer = new FakeRenderer();
  const reportWithWrongHash: IntegrityReport = {
    ...OK_INTEGRITY_REPORT,
    compositionSourceHash: "x".repeat(64),
  };
  const ctx = { ...VALID_CONTEXT, integrityReport: reportWithWrongHash };
  await assert.rejects(
    () => renderer.render(VALID_COMPOSITION, ctx),
    (err) => err instanceof RenderError && /compositionSourceHash/.test(err.message)
  );
});

test("throws RenderError when visual asset in composition lacks an OK integrity result", async () => {
  const renderer = new FakeRenderer();
  const reportMissingVisual: IntegrityReport = {
    ...OK_INTEGRITY_REPORT,
    assets: OK_INTEGRITY_REPORT.assets.filter((a) => a.kind !== "visual"),
  };
  const ctx = { ...VALID_CONTEXT, integrityReport: reportMissingVisual };
  await assert.rejects(
    () => renderer.render(VALID_COMPOSITION, ctx),
    (err) => err instanceof RenderError && /visual asset 'VAS_1'/.test(err.message)
  );
});

test("throws RenderError when audio asset in composition lacks an OK integrity result", async () => {
  const renderer = new FakeRenderer();
  const reportMissingAudio: IntegrityReport = {
    ...OK_INTEGRITY_REPORT,
    assets: OK_INTEGRITY_REPORT.assets.filter((a) => a.kind !== "audio"),
  };
  const ctx = { ...VALID_CONTEXT, integrityReport: reportMissingAudio };
  await assert.rejects(
    () => renderer.render(VALID_COMPOSITION, ctx),
    (err) => err instanceof RenderError && /audio asset 'AST_1'/.test(err.message)
  );
});

test("throws RenderError when outputPath does not end in .mp4", async () => {
  const renderer = new FakeRenderer();
  const ctx = { ...VALID_CONTEXT, outputPath: "/tmp/output/episode.avi" };
  await assert.rejects(
    () => renderer.render(VALID_COMPOSITION, ctx),
    (err) => err instanceof RenderError && /\.mp4 extension/.test(err.message)
  );
});

test("RenderError preserves the supplied cause Error", () => {
  const cause = new Error("low level issue");
  const err = new RenderError("Precondition failed", cause);
  assert.equal(err.message, "Precondition failed");
  assert.equal(err.name, "RenderError");
  assert.equal(err.cause, cause);
});
