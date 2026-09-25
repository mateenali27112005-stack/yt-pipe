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

const AIFF_BYTES = Buffer.from(
  "464f524d000000264149464600000016434f4d4d00010002000100000" +
  "5dc00104d41524b0000000800000000000000005353" +
  "4e44000000080000000000000000", "hex"
);

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
    assert.ok(filterArg.includes("subtitles='"), "FFmpeg filter_complex must contain subtitles burn-in filter");
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
        const match = filterArg.match(/subtitles='([^']+)'/);
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


