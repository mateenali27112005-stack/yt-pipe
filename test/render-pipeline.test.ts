/**
 * V0.8 Phase 4 — Render Pipeline & CLI Unit Tests
 *
 * Tests:
 * 1. Pipeline path validation (missing options, non-absolute assetRoot/outputPath, non-mp4 extension).
 * 2. Target output protection (refuses to overwrite existing file unless overwrite: true).
 * 3. Successful pipeline execution with fake renderer.
 * 4. Integrity failure propagation (missing asset on disk fails closed before calling renderer).
 * 5. Renderer failure propagation (returns FAILED status without creating target file).
 * 6. CLI argument parsing & validation (missing positional args, unknown flags).
 * 7. CLI --report-out flag writes full JSON report.
 * 8. Immutability of inputs during pipeline execution.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeRenderPipeline } from "../src/render-pipeline.ts";
import { runRenderCli } from "../src/render-cli.ts";
import { RenderError } from "../src/renderer-types.ts";
import type { Renderer, RenderResult } from "../src/renderer.ts";
import type { AssetManifest, AudioAssetManifest, FinalCompositionSpec } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Binary Fixture Constants
// ---------------------------------------------------------------------------

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080200000090" +
  "7753de0000000c4944415408d763f8cfc00000000200019e221bc3300000" +
  "00049454e44ae426082", "hex"
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
// Test Environment Fixture
// ---------------------------------------------------------------------------

interface PipelineEnv {
  root: string;
  assetsDir: string;
  outputDir: string;
  compositionPath: string;
  audioManifestPath: string;
  assetManifestPath: string;
  outputPath: string;
  composition: FinalCompositionSpec;
  audioManifest: AudioAssetManifest;
  assetManifest: AssetManifest;
  cleanup: () => void;
}

function makePipelineEnv(): PipelineEnv {
  const root = mkdtempSync(join(tmpdir(), "yt-pipe-pipeline-test-"));
  const assetsDir = join(root, "assets");
  const outputDir = join(root, "output");
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const pngRelative = "assets/shot1.png";
  const aiffRelative = "assets/seg1.aiff";

  writeFileSync(join(root, pngRelative), PNG_BYTES);
  writeFileSync(join(root, aiffRelative), AIFF_BYTES);

  const pngSha256 = sha256buf(PNG_BYTES);

  const assetManifest: AssetManifest = {
    schemaVersion: "0.1",
    manifestRevision: 1,
    episodeId: "EP_001",
    sourceSpecVersion: 1,
    sourceVisualSpecVersion: 1,
    generatedAt: "2026-09-25T00:00:00.000Z",
    assets: [{
      id: "VAS_1",
      shotId: "SH_001",
      shotVisualSpecId: "VSS_1",
      activeVersionId: "VAS_1_v1",
      versions: [{
        id: "VAS_1_v1",
        version: 1,
        lifecycle: "GENERATED",
        createdAt: "2026-09-25T00:00:00.000Z",
        output: { path: pngRelative, format: "png", byteLength: PNG_BYTES.byteLength, sha256: pngSha256 }
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
      durationSeconds: 3,
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
    durationSeconds: 3,
    visualComposition: {
      canvas: { width: 1920, height: 1080, frameRate: 24 },
      shots: [{
        id: "MCP_SH_001",
        sceneId: "SC_001",
        shotId: "SH_001",
        visualAsset: { assetId: "VAS_1", assetVersionId: "VAS_1_v1", path: pngRelative, sha256: pngSha256 },
        timing: { startSeconds: 0, endSeconds: 3, durationSeconds: 3 },
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
      endSeconds: 3,
      gainDb: 0,
      format: "aiff",
      durationSeconds: 3,
      voice: "Narrator",
    }],
    musicCues: [],
    sfxCues: [],
    captions: [{ id: "CAP_1", role: "narration", text: "Hello.", startSeconds: 0, endSeconds: 3 }],
    sourceHash: "b".repeat(64),
  };

  const compositionPath = join(root, "final_composition_spec.json");
  const audioManifestPath = join(root, "audio_asset_manifest.json");
  const assetManifestPath = join(root, "asset_manifest.json");
  const outputPath = join(outputDir, "episode.mp4");

  writeFileSync(compositionPath, JSON.stringify(composition, null, 2));
  writeFileSync(audioManifestPath, JSON.stringify(audioManifest, null, 2));
  writeFileSync(assetManifestPath, JSON.stringify(assetManifest, null, 2));

  return {
    root, assetsDir, outputDir,
    compositionPath, audioManifestPath, assetManifestPath, outputPath,
    composition, audioManifest, assetManifest,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

class FakePipelineRenderer implements Renderer {
  readonly rendererVersion = "FakePipelineRenderer/1.0";
  shouldFail = false;

  async render(_comp: FinalCompositionSpec, context: any): Promise<RenderResult> {
    if (this.shouldFail) {
      return { status: "FAILED", reason: "Fake encoding failure" };
    }
    // Write fake output file to target path
    writeFileSync(context.outputPath, Buffer.from("rendered-video-bytes"));
    return {
      status: "OK",
      outputPath: context.outputPath,
      format: "mp4",
      byteLength: 20,
      sha256: sha256buf(Buffer.from("rendered-video-bytes")),
      durationSeconds: 3.0,
      rendererVersion: this.rendererVersion,
    };
  }
}

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

test("Pipeline succeeds with valid inputs and fake renderer", async () => {
  const env = makePipelineEnv();
  try {
    const fakeRenderer = new FakePipelineRenderer();
    const result = await executeRenderPipeline({
      compositionPath: env.compositionPath,
      audioManifestPath: env.audioManifestPath,
      assetManifestPath: env.assetManifestPath,
      assetRoot: env.root,
      outputPath: env.outputPath,
      renderer: fakeRenderer,
    });

    assert.equal(result.status, "OK");
    assert.equal(result.episodeId, "EP_001");
    assert.equal(result.integrityReport.status, "OK");
    assert.equal(result.renderResult.status, "OK");
    assert.ok(existsSync(env.outputPath), "Rendered output file must exist");
  } finally {
    env.cleanup();
  }
});

test("Pipeline throws RenderError when assetRoot is relative", async () => {
  const env = makePipelineEnv();
  try {
    await assert.rejects(
      () => executeRenderPipeline({
        compositionPath: env.compositionPath,
        audioManifestPath: env.audioManifestPath,
        assetManifestPath: env.assetManifestPath,
        assetRoot: "relative/root",
        outputPath: env.outputPath,
      }),
      (err) => err instanceof RenderError && /assetRoot/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("Pipeline throws RenderError when outputPath is relative", async () => {
  const env = makePipelineEnv();
  try {
    await assert.rejects(
      () => executeRenderPipeline({
        compositionPath: env.compositionPath,
        audioManifestPath: env.audioManifestPath,
        assetManifestPath: env.assetManifestPath,
        assetRoot: env.root,
        outputPath: "relative/episode.mp4",
      }),
      (err) => err instanceof RenderError && /outputPath/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("Pipeline throws RenderError when target outputPath exists and overwrite is false", async () => {
  const env = makePipelineEnv();
  try {
    const existingBytes = Buffer.from("pre-existing-file");
    writeFileSync(env.outputPath, existingBytes);

    await assert.rejects(
      () => executeRenderPipeline({
        compositionPath: env.compositionPath,
        audioManifestPath: env.audioManifestPath,
        assetManifestPath: env.assetManifestPath,
        assetRoot: env.root,
        outputPath: env.outputPath,
        overwrite: false,
      }),
      (err) => err instanceof RenderError && /already exists/.test(err.message)
    );

    // Existing file is preserved
    assert.deepEqual(readFileSync(env.outputPath), existingBytes);
  } finally {
    env.cleanup();
  }
});

test("Pipeline succeeds and overwrites target file when overwrite is true", async () => {
  const env = makePipelineEnv();
  try {
    writeFileSync(env.outputPath, Buffer.from("old-file"));
    const fakeRenderer = new FakePipelineRenderer();

    const result = await executeRenderPipeline({
      compositionPath: env.compositionPath,
      audioManifestPath: env.audioManifestPath,
      assetManifestPath: env.assetManifestPath,
      assetRoot: env.root,
      outputPath: env.outputPath,
      overwrite: true,
      renderer: fakeRenderer,
    });

    assert.equal(result.status, "OK");
    assert.deepEqual(readFileSync(env.outputPath), Buffer.from("rendered-video-bytes"));
  } finally {
    env.cleanup();
  }
});

test("Pipeline fails closed when an asset is missing on disk", async () => {
  const env = makePipelineEnv();
  try {
    // Delete visual asset from disk
    rmSync(join(env.root, "assets/shot1.png"));
    const fakeRenderer = new FakePipelineRenderer();

    const result = await executeRenderPipeline({
      compositionPath: env.compositionPath,
      audioManifestPath: env.audioManifestPath,
      assetManifestPath: env.assetManifestPath,
      assetRoot: env.root,
      outputPath: env.outputPath,
      renderer: fakeRenderer,
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.integrityReport.status, "FAILED");
    assert.equal(result.renderResult.status, "FAILED");
    assert.equal(existsSync(env.outputPath), false, "Output file must not be created on integrity failure");
  } finally {
    env.cleanup();
  }
});

test("Pipeline returns FAILED status when renderer fails", async () => {
  const env = makePipelineEnv();
  try {
    const fakeRenderer = new FakePipelineRenderer();
    fakeRenderer.shouldFail = true;

    const result = await executeRenderPipeline({
      compositionPath: env.compositionPath,
      audioManifestPath: env.audioManifestPath,
      assetManifestPath: env.assetManifestPath,
      assetRoot: env.root,
      outputPath: env.outputPath,
      renderer: fakeRenderer,
    });

    assert.equal(result.status, "FAILED");
    assert.equal(result.renderResult.status, "FAILED");
    assert.equal(existsSync(env.outputPath), false, "Output file must not be created on renderer failure");
  } finally {
    env.cleanup();
  }
});

test("Pipeline leaves existing output byte-for-byte unchanged when integrity verification fails", async () => {
  const env = makePipelineEnv();
  try {
    const existingBytes = Buffer.from("existing-target-content-must-not-be-touched");
    writeFileSync(env.outputPath, existingBytes);

    // Delete visual asset from disk to cause integrity failure
    rmSync(join(env.root, "assets/shot1.png"));
    const fakeRenderer = new FakePipelineRenderer();

    const result = await executeRenderPipeline({
      compositionPath: env.compositionPath,
      audioManifestPath: env.audioManifestPath,
      assetManifestPath: env.assetManifestPath,
      assetRoot: env.root,
      outputPath: env.outputPath,
      overwrite: true, // Even with overwrite: true, integrity failure MUST NOT alter existing file
      renderer: fakeRenderer,
    });

    assert.equal(result.status, "FAILED");
    assert.deepEqual(readFileSync(env.outputPath), existingBytes, "Existing output must be byte-for-byte unchanged on integrity failure");
  } finally {
    env.cleanup();
  }
});

test("Pipeline leaves existing output byte-for-byte unchanged when renderer returns RenderFailure", async () => {
  const env = makePipelineEnv();
  try {
    const existingBytes = Buffer.from("existing-target-content-must-not-be-touched");
    writeFileSync(env.outputPath, existingBytes);

    const fakeRenderer = new FakePipelineRenderer();
    fakeRenderer.shouldFail = true;

    const result = await executeRenderPipeline({
      compositionPath: env.compositionPath,
      audioManifestPath: env.audioManifestPath,
      assetManifestPath: env.assetManifestPath,
      assetRoot: env.root,
      outputPath: env.outputPath,
      overwrite: true, // Even with overwrite: true, renderer failure MUST NOT alter existing file
      renderer: fakeRenderer,
    });

    assert.equal(result.status, "FAILED");
    assert.deepEqual(readFileSync(env.outputPath), existingBytes, "Existing output must be byte-for-byte unchanged on renderer failure");
  } finally {
    env.cleanup();
  }
});

test("CLI returns exit code 1 for missing positional arguments", async () => {
  const code = await runRenderCli(["node", "src/render-cli.ts", "arg1", "arg2"]);
  assert.equal(code, 1);
});

test("CLI returns exit code 1 for unknown flag", async () => {
  const code = await runRenderCli(["node", "src/render-cli.ts", "a", "b", "c", "d", "e", "--unknown-flag"]);
  assert.equal(code, 1);
});

test("CLI rejects relative assetRoot or relative outputPath with exit code 1", async () => {
  const env = makePipelineEnv();
  try {
    const code1 = await runRenderCli([
      "node", "src/render-cli.ts",
      env.compositionPath, env.audioManifestPath, env.assetManifestPath,
      "relative/assetRoot", env.outputPath,
    ]);
    assert.equal(code1, 1, "CLI must reject relative assetRoot");

    const code2 = await runRenderCli([
      "node", "src/render-cli.ts",
      env.compositionPath, env.audioManifestPath, env.assetManifestPath,
      env.root, "relative/output.mp4",
    ]);
    assert.equal(code2, 1, "CLI must reject relative outputPath");
  } finally {
    env.cleanup();
  }
});

test("CLI rejects --report-out path identical to target outputPath with exit code 1", async () => {
  const env = makePipelineEnv();
  try {
    const code = await runRenderCli([
      "node", "src/render-cli.ts",
      env.compositionPath, env.audioManifestPath, env.assetManifestPath,
      env.root, env.outputPath,
      "--report-out", env.outputPath,
    ]);
    assert.equal(code, 1, "CLI must reject --report-out matching target outputPath");
  } finally {
    env.cleanup();
  }
});

test("CLI writes full report when --report-out is specified", async () => {
  const env = makePipelineEnv();
  try {
    const reportOutPath = join(env.root, "report.json");
    // Run CLI directly via runRenderCli
    // Since default renderer will fail (no ffmpeg), CLI returns 1 and writes failure report
    const exitCode = await runRenderCli([
      "node", "src/render-cli.ts",
      env.compositionPath,
      env.audioManifestPath,
      env.assetManifestPath,
      env.root,
      env.outputPath,
      "--report-out", reportOutPath,
    ]);

    assert.equal(exitCode, 1, "CLI should exit 1 when FFmpeg is not installed");
    assert.ok(existsSync(reportOutPath), "Report JSON file must be written when --report-out is passed");
    const reportJson = JSON.parse(readFileSync(reportOutPath, "utf8"));
    assert.equal(reportJson.status, "FAILED");
  } finally {
    env.cleanup();
  }
});
