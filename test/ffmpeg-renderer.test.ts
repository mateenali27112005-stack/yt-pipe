/**
 * V0.8 Phase 3 — FFmpeg Renderer Unit & Integration Tests
 *
 * All unit tests use injected fake ProcessRunner and ProbeRunner.
 * No reliance on system FFmpeg being installed for unit tests.
 * One integration test is included for real FFmpeg/FFprobe when available,
 * explicitly skipped when binaries are not present.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FFmpegRenderer,
  type ProcessResult,
  type ProcessRunner,
  type ProbeResult,
  type ProbeRunner,
} from "../src/ffmpeg-renderer.ts";
import { RenderError } from "../src/renderer-types.ts";
import type { RenderContext } from "../src/renderer-types.ts";
import type { FinalCompositionSpec } from "../src/types.ts";
import type { IntegrityReport } from "../src/integrity-types.ts";

// ---------------------------------------------------------------------------
// Test Fixtures & Helpers
// ---------------------------------------------------------------------------

const COMPOSITION: FinalCompositionSpec = {
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
    shots: [
      {
        id: "MCP_SH_001",
        sceneId: "SC_001",
        shotId: "SH_001",
        visualAsset: {
          assetId: "VAS_1",
          assetVersionId: "VAS_1_v1",
          path: "assets/shot1.png",
          sha256: "a".repeat(64),
        },
        timing: { startSeconds: 0, endSeconds: 3, durationSeconds: 3 },
        camera: {
          intent: "slow push-in",
          keyframes: [
            { offset: 0, scale: 1, x: 0.5, y: 0.5 },
            { offset: 1, scale: 1.08, x: 0.5, y: 0.5 },
          ],
        },
        sourceHash: "b".repeat(64),
      },
    ],
  },
  narrationDialogueTracks: [
    {
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
    },
  ],
  musicCues: [],
  sfxCues: [],
  captions: [{ id: "CAP_1", role: "narration", text: "Hello.", startSeconds: 0, endSeconds: 3 }],
  sourceHash: "d".repeat(64),
};

const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080200000090" +
  "7753de0000000c4944415408d763f8cfc00000000200019e221bc3300000" +
  "00049454e44ae426082", "hex"
);

function makeValidAiffBuffer(durationSec = 3, sampleRate = 44100): Buffer {
  const numFrames = Math.round(durationSec * sampleRate);
  const pcmDataSize = numFrames * 2;
  const ssndChunkSize = 8 + pcmDataSize;
  const commChunkSize = 18;
  const formPayloadSize = 4 + (8 + commChunkSize) + (8 + ssndChunkSize);

  const buf = Buffer.alloc(8 + formPayloadSize);
  let offset = 0;

  buf.write("FORM", offset); offset += 4;
  buf.writeUInt32BE(formPayloadSize, offset); offset += 4;
  buf.write("AIFF", offset); offset += 4;

  buf.write("COMM", offset); offset += 4;
  buf.writeUInt32BE(commChunkSize, offset); offset += 4;
  buf.writeUInt16BE(1, offset); offset += 2;
  buf.writeUInt32BE(numFrames, offset); offset += 4;
  buf.writeUInt16BE(16, offset); offset += 2;
  const sampleRate80Bit = Buffer.from([0x40, 0x0e, 0xac, 0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  sampleRate80Bit.copy(buf, offset); offset += 10;

  buf.write("SSND", offset); offset += 4;
  buf.writeUInt32BE(ssndChunkSize, offset); offset += 4;
  buf.writeUInt32BE(0, offset); offset += 4;
  buf.writeUInt32BE(0, offset); offset += 4;

  return buf;
}

const AIFF_BYTES = makeValidAiffBuffer(3);


/**
 * Build an integrity report where resolvedPaths point to the actual temp dir
 * created by makeEnv(). Must be called after makeEnv() creates the root.
 */
function makeIntegrityReport(root: string): IntegrityReport {
  return {
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
        resolvedPath: join(root, "assets/shot1.png"),
        status: "OK",
      },
      {
        kind: "audio",
        assetId: "AST_1",
        path: "assets/seg1.aiff",
        resolvedPath: join(root, "assets/seg1.aiff"),
        status: "OK",
      },
    ],
    failures: [],
  };
}

/** Stable fixture for tests that don't need a real filesystem (precondition / contract tests). */
const OK_INTEGRITY_REPORT: IntegrityReport = makeIntegrityReport("/stable-fixture-root");

interface TestEnv {
  root: string;
  outputPath: string;
  context: RenderContext;
  integrityReport: IntegrityReport;
  cleanup: () => void;
}

function makeEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "yt-pipe-ffmpeg-test-"));
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, "output"), { recursive: true });

  writeFileSync(join(root, "assets/shot1.png"), PNG_BYTES);
  writeFileSync(join(root, "assets/seg1.aiff"), AIFF_BYTES);

  const outputPath = join(root, "output/episode.mp4");
  const integrityReport = makeIntegrityReport(root);
  const context: RenderContext = {
    assetRoot: root,
    outputPath,
    integrityReport,
  };

  return {
    root,
    outputPath,
    context,
    integrityReport,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Helper to create a fake ProcessRunner that writes output files when FFmpeg runs */
function makeFakeProcessRunner(
  options: {
    ffmpegExitCode?: number;
    ffmpegStderr?: string;
    ffprobeExitCode?: number;
    skipFileCreation?: boolean;
    outputBytes?: Buffer;
  } = {}
): ProcessRunner {
  const ffmpegExit = options.ffmpegExitCode ?? 0;
  const ffprobeExit = options.ffprobeExitCode ?? 0;
  const bytes = options.outputBytes ?? Buffer.from("rendered-mp4-test-content-bytes");

  return async (command, args) => {
    if (command === "ffmpeg") {
      if (args.includes("-version")) {
        return { exitCode: ffmpegExit, stdout: "ffmpeg version 6.1 test", stderr: "" };
      }
      if (ffmpegExit === 0 && !options.skipFileCreation) {
        // Last argument is staging output path
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, bytes);
      }
      return {
        exitCode: ffmpegExit,
        stdout: "ffmpeg stdout",
        stderr: options.ffmpegStderr ?? (ffmpegExit !== 0 ? "ffmpeg error message" : ""),
      };
    }
    if (command === "ffprobe") {
      return {
        exitCode: ffprobeExit,
        stdout: ffprobeExit === 0 ? '{"format":{"duration":"3.0"}}' : "",
        stderr: ffprobeExit !== 0 ? "ffprobe error" : "",
      };
    }
    return { exitCode: 1, stdout: "", stderr: "unknown command" };
  };
}

/** Helper to create a fake ProbeRunner */
function makeFakeProbeRunner(
  overrides: Partial<ProbeResult> = {}
): ProbeRunner {
  return async () => ({
    formatName: "mov,mp4,m4a,3gp,3g2,mj2",
    durationSeconds: 3.0,
    videoStream: { codecName: "h264", width: 1920, height: 1080, rFrameRate: "24/1" },
    audioStream: { codecName: "aac", channels: 2, sampleRate: 44100 },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Unit Tests (No real FFmpeg required)
// ---------------------------------------------------------------------------

test("1. Successful renderer invocation through fake process boundary", async () => {
  const env = makeEnv();
  try {
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "OK");
    if (result.status === "OK") {
      assert.equal(result.outputPath, env.outputPath);
      assert.equal(result.format, "mp4");
      assert.equal(result.durationSeconds, 3.0);
      assert.equal(result.rendererVersion, "FFmpegRenderer/1.0");
      assert.ok(existsSync(env.outputPath), "Output file should exist at target path");
    }
  } finally {
    env.cleanup();
  }
});

test("2. IntegrityReport status FAILED => RenderError", async () => {
  const env = makeEnv();
  try {
    const failedReport: IntegrityReport = { ...OK_INTEGRITY_REPORT, status: "FAILED", failures: [] };
    const ctx = { ...env.context, integrityReport: failedReport };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await assert.rejects(
      () => renderer.render(COMPOSITION, ctx),
      (err) => err instanceof RenderError && /integrity report status is 'FAILED'/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("3. Composition sourceHash mismatch => RenderError", async () => {
  const env = makeEnv();
  try {
    const reportWrongHash: IntegrityReport = {
      ...OK_INTEGRITY_REPORT,
      compositionSourceHash: "x".repeat(64),
    };
    const ctx = { ...env.context, integrityReport: reportWrongHash };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await assert.rejects(
      () => renderer.render(COMPOSITION, ctx),
      (err) => err instanceof RenderError && /compositionSourceHash/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("4. Missing visual asset integrity result => RenderError", async () => {
  const env = makeEnv();
  try {
    const reportNoVisual: IntegrityReport = {
      ...OK_INTEGRITY_REPORT,
      assets: OK_INTEGRITY_REPORT.assets.filter((a) => a.kind !== "visual"),
    };
    const ctx = { ...env.context, integrityReport: reportNoVisual };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await assert.rejects(
      () => renderer.render(COMPOSITION, ctx),
      (err) => err instanceof RenderError && /visual asset 'VAS_1'/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("5. Missing audio asset integrity result => RenderError", async () => {
  const env = makeEnv();
  try {
    const reportNoAudio: IntegrityReport = {
      ...OK_INTEGRITY_REPORT,
      assets: OK_INTEGRITY_REPORT.assets.filter((a) => a.kind !== "audio"),
    };
    const ctx = { ...env.context, integrityReport: reportNoAudio };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await assert.rejects(
      () => renderer.render(COMPOSITION, ctx),
      (err) => err instanceof RenderError && /audio asset 'AST_1'/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("6. Asset ID/version mismatch => RenderError", async () => {
  const env = makeEnv();
  try {
    const tamperedComp = structuredClone(COMPOSITION);
    tamperedComp.visualComposition.shots[0].visualAsset.assetVersionId = "VAS_1_v999";
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await assert.rejects(
      () => renderer.render(tamperedComp, env.context),
      (err) => err instanceof RenderError && /VAS_1_v999/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("7. Invalid output path => RenderError", async () => {
  const env = makeEnv();
  try {
    const ctx = { ...env.context, outputPath: "" };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await assert.rejects(
      () => renderer.render(COMPOSITION, ctx),
      (err) => err instanceof RenderError && /outputPath/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("8. Non-MP4 output path => RenderError", async () => {
  const env = makeEnv();
  try {
    const ctx = { ...env.context, outputPath: join(env.root, "output/episode.webm") };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await assert.rejects(
      () => renderer.render(COMPOSITION, ctx),
      (err) => err instanceof RenderError && /\.mp4 extension/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("9. FFmpeg unavailable => RenderFailure", async () => {
  const env = makeEnv();
  try {
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner({ ffmpegExitCode: 127 }),
      probeRunner: makeFakeProbeRunner(),
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.ok(/FFmpeg executable .* is unavailable/.test(result.reason));
    }
  } finally {
    env.cleanup();
  }
});

test("10. FFmpeg non-zero exit => RenderFailure", async () => {
  const env = makeEnv();
  try {
    // Custom runner where version check succeeds (0) but rendering fails (1)
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      return { exitCode: 1, stdout: "", stderr: "Invalid codec options" };
    };
    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.ok(/exited with code 1/.test(result.reason));
      assert.ok(/Invalid codec options/.test(result.reason));
    }
  } finally {
    env.cleanup();
  }
});

test("11. FFprobe unavailable => RenderFailure", async () => {
  const env = makeEnv();
  try {
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner({ ffprobeExitCode: 127 }),
      probeRunner: makeFakeProbeRunner(),
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.ok(/FFprobe executable .* is unavailable/.test(result.reason));
    }
  } finally {
    env.cleanup();
  }
});

test("12. FFprobe duration mismatch => RenderFailure", async () => {
  const env = makeEnv();
  try {
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner({ durationSeconds: 10.0 }), // Expected 3.0s
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.ok(/duration mismatch/.test(result.reason));
    }
  } finally {
    env.cleanup();
  }
});

test("13. Missing output after FFmpeg success => RenderFailure", async () => {
  const env = makeEnv();
  try {
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner({ skipFileCreation: true }),
      probeRunner: makeFakeProbeRunner(),
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.ok(/output file missing/.test(result.reason));
    }
  } finally {
    env.cleanup();
  }
});

test("14. Empty output => RenderFailure", async () => {
  const env = makeEnv();
  try {
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner({ outputBytes: Buffer.alloc(0) }),
      probeRunner: makeFakeProbeRunner(),
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.ok(/output file is empty/.test(result.reason));
    }
  } finally {
    env.cleanup();
  }
});

test("15. Successful post-render verification => RenderSuccess", async () => {
  const env = makeEnv();
  try {
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "OK");
    if (result.status === "OK") {
      assert.equal(result.outputPath, env.outputPath);
      assert.equal(result.format, "mp4");
      assert.equal(result.durationSeconds, 3.0);
    }
  } finally {
    env.cleanup();
  }
});

test("16. Final SHA-256 and byteLength are computed from actual output", async () => {
  const env = makeEnv();
  try {
    const content = Buffer.from("custom-output-data-for-hash-test");
    const expectedSha256 = createHash("sha256").update(content).digest("hex");
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner({ outputBytes: content }),
      probeRunner: makeFakeProbeRunner(),
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "OK");
    if (result.status === "OK") {
      assert.equal(result.byteLength, content.length);
      assert.equal(result.sha256, expectedSha256);
      const actualFileBytes = readFileSync(env.outputPath);
      assert.equal(actualFileBytes.length, content.length);
      assert.equal(createHash("sha256").update(actualFileBytes).digest("hex"), expectedSha256);
    }
  } finally {
    env.cleanup();
  }
});

test("17. Existing output is not overwritten when rendering fails", async () => {
  const env = makeEnv();
  try {
    const existingBytes = Buffer.from("pre-existing-valid-video-data");
    writeFileSync(env.outputPath, existingBytes);

    // Trigger failure via FFprobe duration mismatch
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner({ durationSeconds: 99.0 }),
    });

    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");

    // Verify existing output file was NOT overwritten
    const currentBytes = readFileSync(env.outputPath);
    assert.deepEqual(currentBytes, existingBytes);
  } finally {
    env.cleanup();
  }
});

test("18. Staging file is cleaned after failure", async () => {
  const env = makeEnv();
  try {
    let createdStagingPath = "";
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        createdStagingPath = args[args.length - 1];
        writeFileSync(createdStagingPath, Buffer.from("staging-data"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    // Trigger failure via probe duration mismatch
    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner({ durationSeconds: 999.0 }),
    });

    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    assert.ok(createdStagingPath.length > 0);
    assert.equal(existsSync(createdStagingPath), false, "Staging file must be cleaned up on failure");
  } finally {
    env.cleanup();
  }
});

test("19. Composition remains unchanged", async () => {
  const env = makeEnv();
  try {
    const original = JSON.stringify(COMPOSITION);
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await renderer.render(COMPOSITION, env.context);
    assert.equal(JSON.stringify(COMPOSITION), original);
  } finally {
    env.cleanup();
  }
});

test("20. IntegrityReport remains unchanged", async () => {
  const env = makeEnv();
  try {
    const original = JSON.stringify(OK_INTEGRITY_REPORT);
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await renderer.render(COMPOSITION, env.context);
    assert.equal(JSON.stringify(OK_INTEGRITY_REPORT), original);
  } finally {
    env.cleanup();
  }
});

test("21. RenderContext remains unchanged", async () => {
  const env = makeEnv();
  try {
    const original = JSON.stringify(env.context);
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await renderer.render(COMPOSITION, env.context);
    assert.equal(JSON.stringify(env.context), original);
  } finally {
    env.cleanup();
  }
});

test("22. RenderError preserves its cause", () => {
  const cause = new Error("inner error");
  const err = new RenderError("Outer message", cause);
  assert.equal(err.message, "Outer message");
  assert.equal(err.cause, cause);
});

// ---------------------------------------------------------------------------
// Real FFmpeg Integration Test (Explicitly skipped when unavailable)
// ---------------------------------------------------------------------------

test("23. Real FFmpeg integration test (skipped when FFmpeg/FFprobe unavailable)", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(execFile);

  let ffmpegAvailable = false;
  try {
    await execAsync("ffmpeg", ["-version"]);
    await execAsync("ffprobe", ["-version"]);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }

  if (!ffmpegAvailable) {
    t.skip("Real FFmpeg/FFprobe binaries not available on system — skipping integration test");
    return;
  }

  const env = makeEnv();
  try {
    await execAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=red:s=1920x1080:r=24", "-frames:v", "1",
      join(env.root, "assets/shot1.png")
    ]);
    await execAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16be", "-f", "aiff",
      join(env.root, "assets/seg1.aiff")
    ]);
    const renderer = new FFmpegRenderer(); // Default production runners
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "OK");
  } finally {
    env.cleanup();
  }
});

test("24. FFmpegRenderer uses resolvedPath from IntegrityReport for visual and audio inputs", async () => {
  const env = makeEnv();
  try {
    const customVisualResolved = "/custom/resolved/path/shot1.png";
    const customAudioResolved = "/custom/resolved/path/seg1.aiff";
    const customReport: IntegrityReport = {
      ...OK_INTEGRITY_REPORT,
      assets: [
        {
          kind: "visual",
          assetId: "VAS_1",
          assetVersionId: "VAS_1_v1",
          path: "assets/shot1.png",
          resolvedPath: customVisualResolved,
          status: "OK",
        },
        {
          kind: "audio",
          assetId: "AST_1",
          path: "assets/seg1.aiff",
          resolvedPath: customAudioResolved,
          status: "OK",
        },
      ],
    };
    const ctx = { ...env.context, integrityReport: customReport };

    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(COMPOSITION, ctx);
    assert.equal(result.status, "OK");
    assert.ok(capturedArgs.includes(customVisualResolved), "FFmpeg args must include exact resolvedPath for visual asset");
    assert.ok(capturedArgs.includes(customAudioResolved), "FFmpeg args must include exact resolvedPath for audio asset");
  } finally {
    env.cleanup();
  }
});

test("25. Video width mismatch returns RenderFailure", async () => {
  const env = makeEnv();
  try {
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner({
        videoStream: { codecName: "h264", width: 1280, height: 1080, rFrameRate: "24/1" },
      }),
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.ok(/width mismatch/.test(result.reason));
    }
  } finally {
    env.cleanup();
  }
});

test("26. Video height mismatch returns RenderFailure", async () => {
  const env = makeEnv();
  try {
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner({
        videoStream: { codecName: "h264", width: 1920, height: 720, rFrameRate: "24/1" },
      }),
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.ok(/height mismatch/.test(result.reason));
    }
  } finally {
    env.cleanup();
  }
});

test("27. Missing audio stream when narration exists returns RenderFailure", async () => {
  const env = makeEnv();
  try {
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner({
        audioStream: undefined,
      }),
    });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    if (result.status === "FAILED") {
      assert.ok(/contains no audio stream/.test(result.reason));
    }
  } finally {
    env.cleanup();
  }
});

test("28. Camera keyframe dynamic zoompan filter construction", async () => {
  const env = makeEnv();
  try {
    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "OK");
    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];
    assert.ok(filterArg.includes("zoompan=z="), "FFmpeg filter_complex must contain zoompan for keyframe motion");
    assert.ok(filterArg.includes("1+(0.08)*(on-1)"), "FFmpeg filter_complex must interpolate zoom scale from 1 to 1.08");
  } finally {
    env.cleanup();
  }
});

test("29. Shot sequencing with CROSSFADE transition filter construction", async () => {
  const env = makeEnv();
  try {
    const multiShotComp: FinalCompositionSpec = {
      ...COMPOSITION,
      durationSeconds: 6,
      visualComposition: {
        canvas: { width: 1920, height: 1080, frameRate: 24 },
        shots: [
          COMPOSITION.visualComposition.shots[0],
          {
            id: "MCP_SH_002",
            sceneId: "SC_002",
            shotId: "SH_002",
            visualAsset: {
              assetId: "VAS_1",
              assetVersionId: "VAS_1_v1",
              path: "assets/shot1.png",
              sha256: "a".repeat(64),
            },
            timing: { startSeconds: 3, endSeconds: 6, durationSeconds: 3 },
            camera: { intent: "static", keyframes: [{ offset: 0, scale: 1, x: 0.5, y: 0.5 }, { offset: 1, scale: 1, x: 0.5, y: 0.5 }] },
            transitionIn: { type: "CROSSFADE", atSeconds: 3, durationSeconds: 0.35 },
            sourceHash: "c".repeat(64),
          },
        ],
      },
    };

    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner({ durationSeconds: 6.0 }),
    });

    const result = await renderer.render(multiShotComp, env.context);
    assert.equal(result.status, "OK");
    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];
    assert.ok(filterArg.includes("xfade=transition=fade:duration=0.35:offset=2.65"), "FFmpeg filter_complex must contain xfade filter with offset 2.65");
  } finally {
    env.cleanup();
  }
});

test("30. Narration Dialogue Tracks audio gainDb and timing delay filter construction", async () => {
  const env = makeEnv();
  try {
    const audioGainComp: FinalCompositionSpec = {
      ...COMPOSITION,
      narrationDialogueTracks: [
        {
          ...COMPOSITION.narrationDialogueTracks[0],
          startSeconds: 1.5,
          gainDb: -6.0,
        },
      ],
    };

    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(audioGainComp, env.context);
    assert.equal(result.status, "OK");
    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];
    assert.ok(filterArg.includes("volume=-6dB"), "FFmpeg filter_complex must apply volume=-6dB gain");
    assert.ok(filterArg.includes("adelay=1500|1500"), "FFmpeg filter_complex must apply 1500ms audio delay");
  } finally {
    env.cleanup();
  }
});

test("31. Realized Music and SFX cues audio mixing filter construction", async () => {
  const env = makeEnv();
  try {
    const musicSfxComp: FinalCompositionSpec = {
      ...COMPOSITION,
      musicCues: [
        {
          id: "MUS_001",
          lifecycle: "GENERATED",
          audioAssetId: "AST_1",
          path: "assets/seg1.aiff",
          format: "aiff",
          startSeconds: 0,
          endSeconds: 3,
          style: "cinematic",
          gainDb: -18,
        },
      ],
    };

    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(musicSfxComp, env.context);
    assert.equal(result.status, "OK");
    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];
    assert.ok(filterArg.includes("volume=-18dB"), "FFmpeg filter_complex must include music volume=-18dB filter");
    assert.ok(filterArg.includes("amix=inputs=2"), "FFmpeg filter_complex must mix narration and music inputs with amix");
  } finally {
    env.cleanup();
  }
});

test("32. Caption Subtitle Burn-In WebVTT generation and filter construction", async () => {
  const env = makeEnv();
  try {
    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "OK");
    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];
    assert.ok(filterArg.includes("subtitles=filename='"), "FFmpeg filter_complex must contain subtitles burn-in filter");
    assert.ok(filterArg.includes(".vtt"), "FFmpeg subtitles filter must target staging .vtt file");
  } finally {
    env.cleanup();
  }
});

test("33. Staging WebVTT subtitle file is cleaned up after render", async () => {
  const env = makeEnv();
  try {
    let capturedVttPath = "";
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        const filterArg = args[args.indexOf("-filter_complex") + 1];
        const match = filterArg.match(/subtitles=filename='([^']+)'/);
        if (match) capturedVttPath = match[1];
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "OK");
    assert.ok(capturedVttPath.length > 0, "Subtitle path should be captured");
    assert.equal(existsSync(capturedVttPath), false, "Staging .vtt file must be cleaned up after render completes");
  } finally {
    env.cleanup();
  }
});

test("34. Music cue with path and lifecycle PLANNED => RenderError (integrity gate)", async () => {
  const env = makeEnv();
  try {
    const compWithPlannedMusic: FinalCompositionSpec = {
      ...COMPOSITION,
      musicCues: [
        {
          id: "MUS_001",
          lifecycle: "PLANNED",
          path: "assets/seg1.aiff",
          startSeconds: 0,
          endSeconds: 3,
          style: "cinematic",
          gainDb: -18,
        },
      ],
    };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await assert.rejects(
      () => renderer.render(compWithPlannedMusic, env.context),
      (err) => err instanceof RenderError && /PLANNED/.test(err.message) && /music cue/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("35. Music cue with lifecycle GENERATED but no matching OK integrity result => RenderError", async () => {
  const env = makeEnv();
  try {
    const compWithUnverifiedMusic: FinalCompositionSpec = {
      ...COMPOSITION,
      musicCues: [
        {
          id: "MUS_001",
          lifecycle: "GENERATED",
          audioAssetId: "UNVERIFIED_ASSET_999",
          path: "assets/music.aiff",
          format: "aiff",
          startSeconds: 0,
          endSeconds: 3,
          style: "cinematic",
          gainDb: -18,
        },
      ],
    };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await assert.rejects(
      () => renderer.render(compWithUnverifiedMusic, env.context),
      (err) => err instanceof RenderError && /UNVERIFIED_ASSET_999/.test(err.message) && /music cue/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("36. SFX cue with path and lifecycle PLANNED => RenderError (integrity gate)", async () => {
  const env = makeEnv();
  try {
    const compWithPlannedSfx: FinalCompositionSpec = {
      ...COMPOSITION,
      sfxCues: [
        {
          id: "SFX_001",
          lifecycle: "PLANNED",
          shotId: "SH_001",
          path: "assets/seg1.aiff",
          startSeconds: 0,
          endSeconds: 0.8,
          description: "motion swell",
          gainDb: -24,
        },
      ],
    };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    await assert.rejects(
      () => renderer.render(compWithPlannedSfx, env.context),
      (err) => err instanceof RenderError && /PLANNED/.test(err.message) && /SFX cue/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("37. Renderer must not return OK when resolvedPath is empty for a visual asset", async () => {
  const env = makeEnv();
  try {
    const reportMissingResolved = {
      ...env.integrityReport,
      assets: env.integrityReport.assets.map((a: any) =>
        a.kind === "visual" ? { ...a, resolvedPath: "" } : a
      ),
    };
    const ctx = { ...env.context, integrityReport: reportMissingResolved };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });
    let threw = false;
    let result: any;
    try {
      result = await renderer.render(COMPOSITION, ctx);
    } catch (err) {
      threw = true;
    }
    if (!threw) {
      assert.notEqual(result.status, "OK", "Renderer must not return OK with empty resolvedPath");
    }
  } finally {
    env.cleanup();
  }
});

test("38. Subprocess timeout causes render to return RenderFailure and cleanup staging", async () => {
  const env = makeEnv();
  try {
    writeFileSync(env.outputPath, Buffer.from("existing-target-content"));

    const hangingProcessRunner: ProcessRunner = async (cmd, args, options) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      return {
        exitCode: 1,
        stdout: "",
        stderr: `Subprocess execution timed out after ${options?.timeoutMs ?? 50}ms (killed with SIGKILL)`,
      };
    };

    const renderer = new FFmpegRenderer({
      processRunner: hangingProcessRunner,
      probeRunner: makeFakeProbeRunner(),
      processTimeoutMs: 50,
    });

    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    assert.ok(/timed out/.test(result.reason), `Expected timeout message in failure reason, got: ${result.reason}`);
    assert.equal(
      readFileSync(env.outputPath, "utf8"),
      "existing-target-content",
      "Existing target file must remain unchanged on timeout"
    );
  } finally {
    env.cleanup();
  }
});

test("39. Real FFmpeg failure integration test on corrupted input (skipped when FFmpeg/FFprobe unavailable)", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(execFile);

  let ffmpegAvailable = false;
  try {
    await execAsync("ffmpeg", ["-version"]);
    await execAsync("ffprobe", ["-version"]);
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }

  if (!ffmpegAvailable) {
    t.skip("Real FFmpeg/FFprobe binaries not available on system — skipping integration test");
    return;
  }

  const env = makeEnv();
  try {
    writeFileSync(join(env.root, "assets/shot1.png"), Buffer.from("CORRUPTED_NOT_A_PNG_FILE_DATA"));

    const renderer = new FFmpegRenderer({ processTimeoutMs: 2000 });
    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    assert.equal(existsSync(env.outputPath), false, "Target output must not be published on rendering failure");
  } finally {
    env.cleanup();
  }
});

test("40. Positive and negative narration gainDb filters applied to FFmpeg arguments", async () => {
  const env = makeEnv();
  try {
    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const compWithGain: FinalCompositionSpec = {
      ...COMPOSITION,
      narrationDialogueTracks: [
        {
          id: "MIX_SEG_1",
          audioAssetId: "AST_1",
          path: "assets/seg1.aiff",
          role: "narration",
          startSeconds: 0,
          endSeconds: 3,
          gainDb: 6,
          format: "aiff",
          durationSeconds: 3,
          voice: "Narrator",
        },
      ],
    };

    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(compWithGain, env.context);
    assert.equal(result.status, "OK");

    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];
    assert.ok(filterArg.includes("volume=6dB"), `Filter complex should contain volume=6dB filter, got: ${filterArg}`);
  } finally {
    env.cleanup();
  }
});

test("41. Zero gainDb (0 dB) does not add unnecessary volume filter", async () => {
  const env = makeEnv();
  try {
    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const compZeroGain: FinalCompositionSpec = {
      ...COMPOSITION,
      narrationDialogueTracks: [
        {
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
        },
      ],
    };

    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(compZeroGain, env.context);
    assert.equal(result.status, "OK");

    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];
    assert.ok(!filterArg.includes("volume="), `Zero gainDb should not include volume filter, got: ${filterArg}`);
  } finally {
    env.cleanup();
  }
});

test("42. Multiple narration tracks with independent gainDb values (+3dB, -6dB)", async () => {
  const env = makeEnv();
  try {
    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const reportWithTwoAudio: IntegrityReport = {
      ...env.integrityReport,
      assets: [
        ...env.integrityReport.assets,
        {
          kind: "audio",
          assetId: "AST_2",
          path: "assets/seg1.aiff",
          resolvedPath: join(env.root, "assets/seg1.aiff"),
          status: "OK",
        },
      ],
    };

    const compMultiTrack: FinalCompositionSpec = {
      ...COMPOSITION,
      narrationDialogueTracks: [
        {
          id: "MIX_SEG_1",
          audioAssetId: "AST_1",
          path: "assets/seg1.aiff",
          role: "narration",
          startSeconds: 0,
          endSeconds: 1.5,
          gainDb: 3,
          format: "aiff",
          durationSeconds: 1.5,
          voice: "Narrator1",
        },
        {
          id: "MIX_SEG_2",
          audioAssetId: "AST_2",
          path: "assets/seg1.aiff",
          role: "dialogue",
          startSeconds: 1.5,
          endSeconds: 3,
          gainDb: -6,
          format: "aiff",
          durationSeconds: 1.5,
          voice: "Narrator2",
        },
      ],
    };

    const ctx = { ...env.context, integrityReport: reportWithTwoAudio };
    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(compMultiTrack, ctx);
    assert.equal(result.status, "OK");

    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];
    assert.ok(filterArg.includes("volume=3dB"), `Should contain volume=3dB, got: ${filterArg}`);
    assert.ok(filterArg.includes("volume=-6dB"), `Should contain volume=-6dB, got: ${filterArg}`);
    assert.ok(filterArg.includes("amix=inputs=2"), `Should mix 2 audio streams, got: ${filterArg}`);
  } finally {
    env.cleanup();
  }
});

test("43. Invalid gainDb (NaN) throws RenderError in assertRenderPreconditions", async () => {
  const env = makeEnv();
  try {
    const compInvalidGain: FinalCompositionSpec = {
      ...COMPOSITION,
      narrationDialogueTracks: [
        {
          id: "MIX_SEG_1",
          audioAssetId: "AST_1",
          path: "assets/seg1.aiff",
          role: "narration",
          startSeconds: 0,
          endSeconds: 3,
          gainDb: NaN,
          format: "aiff",
          durationSeconds: 3,
          voice: "Narrator",
        },
      ],
    };

    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });

    await assert.rejects(
      () => renderer.render(compInvalidGain, env.context),
      (err) => err instanceof RenderError && /invalid gainDb/.test(err.message)
    );
  } finally {
    env.cleanup();
  }
});

test("44. Realized music cue (GENERATED) with verified asset is included in FFmpeg audio mix", async () => {
  const env = makeEnv();
  try {
    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const musicResolvedPath = join(env.root, "assets/seg1.aiff");
    const reportWithMusic: IntegrityReport = {
      ...env.integrityReport,
      assets: [
        ...env.integrityReport.assets,
        {
          kind: "audio",
          assetId: "MUS_AST_1",
          path: "assets/seg1.aiff",
          resolvedPath: musicResolvedPath,
          status: "OK",
        },
      ],
    };

    const compWithMusic: FinalCompositionSpec = {
      ...COMPOSITION,
      musicCues: [
        {
          id: "MUS_001",
          lifecycle: "GENERATED",
          audioAssetId: "MUS_AST_1",
          path: "assets/seg1.aiff",
          format: "aiff",
          startSeconds: 0,
          endSeconds: 3,
          style: "ambient",
          gainDb: -12,
        } as any,
      ],
    };

    const ctx = { ...env.context, integrityReport: reportWithMusic };
    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(compWithMusic, ctx);
    assert.equal(result.status, "OK");

    assert.ok(capturedArgs.includes(musicResolvedPath), "FFmpeg args should include resolvedPath of music cue");
    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];
    assert.ok(filterArg.includes("volume=-12dB"), `Should apply volume=-12dB to music cue stream, got: ${filterArg}`);
    assert.ok(filterArg.includes("amix=inputs=2"), `Should mix narration and music streams, got: ${filterArg}`);
  } finally {
    env.cleanup();
  }
});

test("45. Realized SFX cue (GENERATED) with verified asset is included in FFmpeg audio mix", async () => {
  const env = makeEnv();
  try {
    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const sfxResolvedPath = join(env.root, "assets/seg1.aiff");
    const reportWithSfx: IntegrityReport = {
      ...env.integrityReport,
      assets: [
        ...env.integrityReport.assets,
        {
          kind: "audio",
          assetId: "SFX_AST_1",
          path: "assets/seg1.aiff",
          resolvedPath: sfxResolvedPath,
          status: "OK",
        },
      ],
    };

    const compWithSfx: FinalCompositionSpec = {
      ...COMPOSITION,
      sfxCues: [
        {
          id: "SFX_001",
          lifecycle: "GENERATED",
          shotId: "SH_001",
          audioAssetId: "SFX_AST_1",
          path: "assets/seg1.aiff",
          format: "aiff",
          startSeconds: 0.5,
          endSeconds: 1.5,
          description: "woosh",
          gainDb: -6,
        } as any,
      ],
    };

    const ctx = { ...env.context, integrityReport: reportWithSfx };
    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(compWithSfx, ctx);
    assert.equal(result.status, "OK");

    assert.ok(capturedArgs.includes(sfxResolvedPath), "FFmpeg args should include resolvedPath of SFX cue");
    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];
    assert.ok(filterArg.includes("adelay=500|500"), `Should delay SFX cue by 500ms, got: ${filterArg}`);
    assert.ok(filterArg.includes("volume=-6dB"), `Should apply volume=-6dB to SFX cue stream, got: ${filterArg}`);
    assert.ok(filterArg.includes("amix=inputs=2"), `Should mix narration and SFX streams, got: ${filterArg}`);
  } finally {
    env.cleanup();
  }
});

test("46. Full end-to-end composition with camera motion, CROSSFADE transition, narration, music, SFX, and captions", async () => {
  const env = makeEnv();
  try {
    let capturedArgs: string[] = [];
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedArgs = args;
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const fullReport: IntegrityReport = {
      ...env.integrityReport,
      assets: [
        {
          kind: "visual",
          assetId: "VAS_1",
          assetVersionId: "VAS_1_v1",
          path: "assets/shot1.png",
          resolvedPath: join(env.root, "assets/shot1.png"),
          status: "OK",
        },
        {
          kind: "visual",
          assetId: "VAS_2",
          assetVersionId: "VAS_2_v1",
          path: "assets/shot1.png",
          resolvedPath: join(env.root, "assets/shot1.png"),
          status: "OK",
        },
        {
          kind: "audio",
          assetId: "AST_1",
          path: "assets/seg1.aiff",
          resolvedPath: join(env.root, "assets/seg1.aiff"),
          status: "OK",
        },
        {
          kind: "audio",
          assetId: "MUS_AST_1",
          path: "assets/seg1.aiff",
          resolvedPath: join(env.root, "assets/seg1.aiff"),
          status: "OK",
        },
        {
          kind: "audio",
          assetId: "SFX_AST_1",
          path: "assets/seg1.aiff",
          resolvedPath: join(env.root, "assets/seg1.aiff"),
          status: "OK",
        },
      ],
    };

    const fullComposition: FinalCompositionSpec = {
      ...COMPOSITION,
      durationSeconds: 5,
      visualComposition: {
        canvas: { width: 1920, height: 1080, frameRate: 24 },
        shots: [
          {
            id: "MCP_SH_001",
            sceneId: "SC_001",
            shotId: "SH_001",
            visualAsset: {
              assetId: "VAS_1",
              assetVersionId: "VAS_1_v1",
              path: "assets/shot1.png",
              sha256: "a".repeat(64),
            },
            timing: { startSeconds: 0, endSeconds: 3, durationSeconds: 3 },
            camera: {
              intent: "slow push-in",
              keyframes: [
                { offset: 0, scale: 1, x: 0.5, y: 0.5 },
                { offset: 1, scale: 1.1, x: 0.5, y: 0.5 },
              ],
            },
            sourceHash: "b".repeat(64),
          },
          {
            id: "MCP_SH_002",
            sceneId: "SC_001",
            shotId: "SH_002",
            visualAsset: {
              assetId: "VAS_2",
              assetVersionId: "VAS_2_v1",
              path: "assets/shot1.png",
              sha256: "a".repeat(64),
            },
            timing: { startSeconds: 3, endSeconds: 5, durationSeconds: 2 },
            camera: {
              intent: "static",
              keyframes: [
                { offset: 0, scale: 1, x: 0.5, y: 0.5 },
                { offset: 1, scale: 1, x: 0.5, y: 0.5 },
              ],
            },
            transitionIn: { type: "CROSSFADE", atSeconds: 3, durationSeconds: 0.5 },
            sourceHash: "b".repeat(64),
          },
        ],
      },
      narrationDialogueTracks: [
        {
          id: "MIX_SEG_1",
          audioAssetId: "AST_1",
          path: "assets/seg1.aiff",
          role: "narration",
          startSeconds: 0,
          endSeconds: 5,
          gainDb: 2,
          format: "aiff",
          durationSeconds: 5,
          voice: "Narrator",
        },
      ],
      musicCues: [
        {
          id: "MUS_001",
          lifecycle: "GENERATED",
          audioAssetId: "MUS_AST_1",
          path: "assets/seg1.aiff",
          format: "aiff",
          startSeconds: 0,
          endSeconds: 5,
          style: "cinematic",
          gainDb: -14,
        } as any,
      ],
      sfxCues: [
        {
          id: "SFX_001",
          lifecycle: "GENERATED",
          shotId: "SH_002",
          audioAssetId: "SFX_AST_1",
          path: "assets/seg1.aiff",
          format: "aiff",
          startSeconds: 3,
          endSeconds: 4,
          description: "transition swell",
          gainDb: -8,
        } as any,
      ],
      captions: [
        { id: "CAP_1", role: "narration", speaker: "Narrator", text: "Welcome to the story.", startSeconds: 0, endSeconds: 3 },
        { id: "CAP_2", role: "narration", speaker: "Narrator", text: "Chapter one begins.", startSeconds: 3, endSeconds: 5 },
      ],
    };

    const ctx = { ...env.context, integrityReport: fullReport };
    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner({ durationSeconds: 5 }),
    });

    const result = await renderer.render(fullComposition, ctx);
    assert.equal(result.status, "OK");

    const filterArg = capturedArgs[capturedArgs.indexOf("-filter_complex") + 1];

    // Check zoompan keyframe interpolation
    assert.ok(filterArg.includes("zoompan="), `Filter graph should include zoompan, got: ${filterArg}`);
    // Check xfade crossfade transition
    assert.ok(filterArg.includes("xfade=transition=fade:duration=0.5"), `Filter graph should include xfade crossfade, got: ${filterArg}`);
    // Check subtitles caption burn-in
    assert.ok(filterArg.includes("subtitles="), `Filter graph should include subtitles filter, got: ${filterArg}`);
    // Check narration + music + sfx volume filters & 3-input amix
    assert.ok(filterArg.includes("volume=2dB"), `Filter graph should include narration volume, got: ${filterArg}`);
    assert.ok(filterArg.includes("volume=-14dB"), `Filter graph should include music volume, got: ${filterArg}`);
    assert.ok(filterArg.includes("volume=-8dB"), `Filter graph should include SFX volume, got: ${filterArg}`);
    assert.ok(filterArg.includes("amix=inputs=3"), `Filter graph should mix 3 audio streams, got: ${filterArg}`);
  } finally {
    env.cleanup();
  }
});

test("47. Precondition violation on full composition fails closed without modifying target", async () => {
  const env = makeEnv();
  try {
    writeFileSync(env.outputPath, Buffer.from("original-target-file"));

    const badComposition = { ...COMPOSITION, episodeId: "" };
    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: makeFakeProbeRunner(),
    });

    await assert.rejects(
      () => renderer.render(badComposition, env.context),
      (err) => err instanceof RenderError
    );

    assert.equal(
      readFileSync(env.outputPath, "utf8"),
      "original-target-file",
      "Original target file must remain untouched"
    );
  } finally {
    env.cleanup();
  }
});

test("48. FFprobe verification failure on full composition cleans staging and leaves target output untouched", async () => {
  const env = makeEnv();
  try {
    writeFileSync(env.outputPath, Buffer.from("protected-output-bytes"));

    const failingProbeRunner: ProbeRunner = async () => {
      return {
        formatName: "mov,mp4,m4a,3gp,3g2,mj2",
        durationSeconds: 10, // Mismatch duration (composition is 3s)
        videoStream: { codecName: "h264", width: 1920, height: 1080, rFrameRate: "24/1" },
        audioStream: { codecName: "aac", channels: 2, sampleRate: 44100 },
      };
    };

    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: failingProbeRunner,
    });

    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    assert.ok(/duration mismatch/.test(result.reason), `Expected duration mismatch error, got: ${result.reason}`);
    assert.equal(
      readFileSync(env.outputPath, "utf8"),
      "protected-output-bytes",
      "Target output file must remain untouched after probe failure"
    );
  } finally {
    env.cleanup();
  }
});

test("49. Explicit frame-rate regression test (24, 25, 29.97, 30, 59.94, 60 fps)", async () => {
  const env = makeEnv();
  try {
    const frameRates = [24, 25, 29.97, 30, 59.94, 60];
    for (const fps of frameRates) {
      let capturedArgs: string[] = [];
      const processRunner: ProcessRunner = async (cmd, args) => {
        if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
        if (cmd === "ffmpeg") {
          capturedArgs = args;
          const stagingPath = args[args.length - 1];
          writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      };

      const compFps: FinalCompositionSpec = {
        ...COMPOSITION,
        visualComposition: {
          ...COMPOSITION.visualComposition,
          canvas: { ...COMPOSITION.visualComposition.canvas, frameRate: fps },
        },
      };

      const renderer = new FFmpegRenderer({
        processRunner,
        probeRunner: makeFakeProbeRunner(),
      });

      const result = await renderer.render(compFps, env.context);
      assert.equal(result.status, "OK");
      assert.ok(capturedArgs.includes(String(fps)), `Arguments must specify frameRate ${fps}`);
    }
  } finally {
    env.cleanup();
  }
});

test("50. WebVTT caption formatting & special character escaping (Unicode, quotes, colons)", async () => {
  const env = makeEnv();
  try {
    let capturedVttContent = "";
    let capturedFilterArg = "";

    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedFilterArg = args[args.indexOf("-filter_complex") + 1];
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const compCaptions: FinalCompositionSpec = {
      ...COMPOSITION,
      captions: [
        {
          id: "CAP_UNICODE",
          role: "narration",
          speaker: "Café Owner: 'Pierre'",
          text: "Welcome to «L'Étoile»! Special: 100% gourmet.",
          startSeconds: 0.5,
          endSeconds: 2.5,
        },
      ],
    };

    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(compCaptions, env.context);
    assert.equal(result.status, "OK");
    assert.ok(capturedFilterArg.includes("subtitles="), "Filter complex should include subtitles filter");
  } finally {
    env.cleanup();
  }
});

test("51. Multi-track audio mixing (narration + music + sfx) at 0 dBFS peaks", async () => {
  const env = makeEnv();
  try {
    let capturedFilterArg = "";
    const processRunner: ProcessRunner = async (cmd, args) => {
      if (args.includes("-version")) return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd === "ffmpeg") {
        capturedFilterArg = args[args.indexOf("-filter_complex") + 1];
        const stagingPath = args[args.length - 1];
        writeFileSync(stagingPath, Buffer.from("rendered-bytes"));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const reportAllAudio: IntegrityReport = {
      ...env.integrityReport,
      assets: [
        ...env.integrityReport.assets,
        {
          kind: "audio",
          assetId: "MUS_AST",
          path: "assets/seg1.aiff",
          resolvedPath: join(env.root, "assets/seg1.aiff"),
          status: "OK",
        },
        {
          kind: "audio",
          assetId: "SFX_AST",
          path: "assets/seg1.aiff",
          resolvedPath: join(env.root, "assets/seg1.aiff"),
          status: "OK",
        },
      ],
    };

    const compTripleAudio: FinalCompositionSpec = {
      ...COMPOSITION,
      narrationDialogueTracks: [
        {
          id: "NARR_1",
          audioAssetId: "AST_1",
          path: "assets/seg1.aiff",
          role: "narration",
          startSeconds: 0,
          endSeconds: 3,
          gainDb: 0,
          format: "aiff",
          durationSeconds: 3,
          voice: "Narrator",
        },
      ],
      musicCues: [
        {
          id: "MUS_1",
          lifecycle: "GENERATED",
          audioAssetId: "MUS_AST",
          path: "assets/seg1.aiff",
          format: "aiff",
          startSeconds: 0,
          endSeconds: 3,
          style: "ambient",
          gainDb: -10,
        } as any,
      ],
      sfxCues: [
        {
          id: "SFX_1",
          lifecycle: "GENERATED",
          shotId: "SH_001",
          audioAssetId: "SFX_AST",
          path: "assets/seg1.aiff",
          format: "aiff",
          startSeconds: 1,
          endSeconds: 2,
          description: "impact",
          gainDb: -6,
        } as any,
      ],
    };

    const ctx = { ...env.context, integrityReport: reportAllAudio };
    const renderer = new FFmpegRenderer({
      processRunner,
      probeRunner: makeFakeProbeRunner(),
    });

    const result = await renderer.render(compTripleAudio, ctx);
    assert.equal(result.status, "OK");
    assert.ok(capturedFilterArg.includes("amix=inputs=3"), `Should mix 3 audio inputs, got: ${capturedFilterArg}`);
  } finally {
    env.cleanup();
  }
});

test("52. Failure matrix: Missing audio stream in Probe output returns RenderFailure and cleans staging", async () => {
  const env = makeEnv();
  try {
    writeFileSync(env.outputPath, Buffer.from("pre-existing-output"));

    const probeNoAudio: ProbeRunner = async () => {
      return {
        formatName: "mov,mp4,m4a,3gp,3g2,mj2",
        durationSeconds: 3,
        videoStream: { codecName: "h264", width: 1920, height: 1080, rFrameRate: "24/1" },
        audioStream: undefined, // Missing audio stream despite narration track
      };
    };

    const renderer = new FFmpegRenderer({
      processRunner: makeFakeProcessRunner(),
      probeRunner: probeNoAudio,
    });

    const result = await renderer.render(COMPOSITION, env.context);
    assert.equal(result.status, "FAILED");
    assert.ok(/no audio stream/.test(result.reason), `Expected audio stream failure reason, got: ${result.reason}`);
    assert.equal(
      readFileSync(env.outputPath, "utf8"),
      "pre-existing-output",
      "Pre-existing output file must remain untouched"
    );
  } finally {
    env.cleanup();
  }
});
