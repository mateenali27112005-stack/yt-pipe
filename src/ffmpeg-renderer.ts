/**
 * V0.8 Phase 3 — FFmpeg-Backed Renderer
 *
 * Implements the Renderer interface using FFmpeg and FFprobe.
 *
 * Pipeline:
 *   FinalCompositionSpec + RenderContext
 *          ↓
 *   assertRenderPreconditions() [Phase 1/2 integrity & asset-level binding]
 *          ↓
 *   check FFmpeg / FFprobe availability
 *          ↓
 *   build FFmpeg args (no shell interpolation)
 *          ↓
 *   render to transactional staging file
 *          ↓
 *   post-render verification via FFprobe (duration, dimensions, streams)
 *          ↓
 *   compute sha256 & byteLength
 *          ↓
 *   atomic rename staging file → final outputPath
 *          ↓
 *   return RenderSuccess
 *
 * Failures (missing binaries, non-zero exit, duration mismatch, missing/empty output):
 *   clean up staging file → return RenderFailure
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, rename, rm, stat } from "node:fs/promises";
import { dirname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";

import type { FinalCompositionSpec } from "./types.ts";
import type { AssetIntegrityResult } from "./integrity-types.ts";
import { assertRenderPreconditions, type Renderer } from "./renderer.ts";
import type { RenderContext, RenderResult } from "./renderer-types.ts";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Process Execution & Media Probing Boundaries
// ---------------------------------------------------------------------------

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string }
) => Promise<ProcessResult>;

export interface VideoStreamInfo {
  codecName?: string;
  width?: number;
  height?: number;
  rFrameRate?: string;
}

export interface AudioStreamInfo {
  codecName?: string;
  channels?: number;
  sampleRate?: number;
}

export interface ProbeResult {
  formatName?: string;
  durationSeconds?: number;
  videoStream?: VideoStreamInfo;
  audioStream?: AudioStreamInfo;
}

export type ProbeRunner = (filePath: string) => Promise<ProbeResult>;

/** Production process runner using child_process.execFile */
export const defaultProcessRunner: ProcessRunner = async (command, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
    });
    return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: any) {
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
    };
  }
};

/** Production probe runner using ffprobe JSON output */
export const defaultProbeRunner: ProbeRunner = async (filePath) => {
  const args = [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ];
  const { exitCode, stdout } = await defaultProcessRunner("ffprobe", args);
  if (exitCode !== 0 || !stdout) {
    throw new Error(`FFprobe failed on file: ${filePath}`);
  }
  const parsed = JSON.parse(stdout);
  const format = parsed.format ?? {};
  const streams: any[] = parsed.streams ?? [];

  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");

  const durationSeconds = format.duration ? parseFloat(format.duration) : undefined;

  return {
    formatName: format.format_name,
    durationSeconds,
    videoStream: video
      ? {
          codecName: video.codec_name,
          width: video.width,
          height: video.height,
          rFrameRate: video.r_frame_rate,
        }
      : undefined,
    audioStream: audio
      ? {
          codecName: audio.codec_name,
          channels: audio.channels,
          sampleRate: audio.sample_rate ? parseInt(audio.sample_rate, 10) : undefined,
        }
      : undefined,
  };
};

// ---------------------------------------------------------------------------
// FFmpegRenderer Implementation
// ---------------------------------------------------------------------------

export interface FFmpegRendererOptions {
  /** Injectable process runner for FFmpeg execution (default: child_process execFile) */
  processRunner?: ProcessRunner;
  /** Injectable probe runner for FFprobe media probing (default: ffprobe exec) */
  probeRunner?: ProbeRunner;
  /** Path to ffmpeg executable (default: "ffmpeg") */
  ffmpegPath?: string;
  /** Path to ffprobe executable (default: "ffprobe") */
  ffprobePath?: string;
  /** Allowed duration mismatch tolerance in seconds between composition and rendered file (default: 0.5s) */
  durationToleranceSeconds?: number;
}

export class FFmpegRenderer implements Renderer {
  readonly rendererVersion = "FFmpegRenderer/1.0";
  private readonly processRunner: ProcessRunner;
  private readonly probeRunner: ProbeRunner;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly durationTolerance: number;

  constructor(options: FFmpegRendererOptions = {}) {
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.probeRunner = options.probeRunner ?? defaultProbeRunner;
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.ffprobePath = options.ffprobePath ?? "ffprobe";
    this.durationTolerance = options.durationToleranceSeconds ?? 0.5;
  }

  async render(composition: FinalCompositionSpec, context: RenderContext): Promise<RenderResult> {
    // 1. Enforce preconditions (throws RenderError for contract violations)
    assertRenderPreconditions(composition, context);

    const normalizedOutput = normalize(resolve(context.outputPath));
    const normalizedRoot = normalize(resolve(context.assetRoot));

    // 2. Verify binary availability
    const ffmpegCheck = await this.processRunner(this.ffmpegPath, ["-version"]);
    if (ffmpegCheck.exitCode !== 0) {
      return {
        status: "FAILED",
        reason: `FFmpeg executable '${this.ffmpegPath}' is unavailable or failed execution check.`,
      };
    }
    const ffprobeCheck = await this.processRunner(this.ffprobePath, ["-version"]);
    if (ffprobeCheck.exitCode !== 0) {
      return {
        status: "FAILED",
        reason: `FFprobe executable '${this.ffprobePath}' is unavailable or failed execution check.`,
      };
    }

    // 3. Build transactional staging path
    const targetDir = dirname(normalizedOutput);
    const tmpSuffix = randomBytes(6).toString("hex");
    const stagingOutput = join(targetDir, `.render_staging_${tmpSuffix}.mp4`);

    try {
      // 4. Construct FFmpeg arguments using exact resolved paths from IntegrityReport
      const ffmpegArgs = this.buildFFmpegArgs(
        composition,
        context.integrityReport.assets,
        normalizedRoot,
        stagingOutput
      );

      // 5. Execute FFmpeg
      const renderProc = await this.processRunner(this.ffmpegPath, ffmpegArgs);
      if (renderProc.exitCode !== 0) {
        await this.safeRemove(stagingOutput);
        return {
          status: "FAILED",
          reason: `FFmpeg process exited with code ${renderProc.exitCode}: ${renderProc.stderr || renderProc.stdout}`,
        };
      }

      // 6. Post-render verification
      try {
        await access(stagingOutput);
      } catch {
        await this.safeRemove(stagingOutput);
        return {
          status: "FAILED",
          reason: `FFmpeg output file missing after rendering: ${stagingOutput}`,
        };
      }

      const fileStat = await stat(stagingOutput);
      if (fileStat.size === 0) {
        await this.safeRemove(stagingOutput);
        return {
          status: "FAILED",
          reason: `FFmpeg output file is empty (0 bytes): ${stagingOutput}`,
        };
      }

      // Probe rendered output
      let probed: ProbeResult;
      try {
        probed = await this.probeRunner(stagingOutput);
      } catch (err: any) {
        await this.safeRemove(stagingOutput);
        return {
          status: "FAILED",
          reason: `Post-render FFprobe verification failed: ${err.message ?? err}`,
          cause: err instanceof Error ? err : undefined,
        };
      }

      // Verify duration
      if (typeof probed.durationSeconds !== "number" || isNaN(probed.durationSeconds)) {
        await this.safeRemove(stagingOutput);
        return {
          status: "FAILED",
          reason: "Post-render verification failed: probed duration is undefined or invalid.",
        };
      }

      const durationDiff = Math.abs(probed.durationSeconds - composition.durationSeconds);
      if (durationDiff > this.durationTolerance) {
        await this.safeRemove(stagingOutput);
        return {
          status: "FAILED",
          reason: `Post-render duration mismatch: expected ${composition.durationSeconds}s ±${this.durationTolerance}s, got ${probed.durationSeconds}s (diff: ${durationDiff.toFixed(3)}s).`,
        };
      }

      // Verify video stream presence & canvas dimensions
      if (!probed.videoStream) {
        await this.safeRemove(stagingOutput);
        return {
          status: "FAILED",
          reason: "Post-render verification failed: output file contains no video stream.",
        };
      }
      const canvas = composition.visualComposition.canvas;
      if (probed.videoStream.width && probed.videoStream.width !== canvas.width) {
        await this.safeRemove(stagingOutput);
        return {
          status: "FAILED",
          reason: `Post-render video width mismatch: expected ${canvas.width}, got ${probed.videoStream.width}.`,
        };
      }
      if (probed.videoStream.height && probed.videoStream.height !== canvas.height) {
        await this.safeRemove(stagingOutput);
        return {
          status: "FAILED",
          reason: `Post-render video height mismatch: expected ${canvas.height}, got ${probed.videoStream.height}.`,
        };
      }

      // Verify audio stream if narration tracks exist
      if (composition.narrationDialogueTracks.length > 0 && !probed.audioStream) {
        await this.safeRemove(stagingOutput);
        return {
          status: "FAILED",
          reason: "Post-render verification failed: composition has narration tracks but output contains no audio stream.",
        };
      }

      // 7. Compute final hashes & byte length
      const actualByteLength = fileStat.size;
      const actualSha256 = await this.computeSha256(stagingOutput);

      // 8. Atomic move staging → final outputPath
      await rename(stagingOutput, normalizedOutput);

      return {
        status: "OK",
        outputPath: normalizedOutput,
        format: "mp4",
        byteLength: actualByteLength,
        sha256: actualSha256,
        durationSeconds: probed.durationSeconds,
        rendererVersion: this.rendererVersion,
      };
    } catch (err: any) {
      await this.safeRemove(stagingOutput);
      return {
        status: "FAILED",
        reason: `Unexpected rendering error: ${err.message ?? err}`,
        cause: err instanceof Error ? err : undefined,
      };
    }
  }

  /**
   * Build explicit FFmpeg arguments array (no shell string escaping required).
   * Inputs are resolved directly from IntegrityReport.assets resolvedPath entries.
   */
  private buildFFmpegArgs(
    composition: FinalCompositionSpec,
    reportAssets: AssetIntegrityResult[],
    assetRoot: string,
    outputPath: string
  ): string[] {
    const canvas = composition.visualComposition.canvas;
    const shots = composition.visualComposition.shots;
    const tracks = composition.narrationDialogueTracks;

    const args: string[] = ["-y"]; // Overwrite staging file if it exists

    // Inputs: Visual assets (use exact resolvedPath from integrity report)
    for (const shot of shots) {
      const matched = reportAssets.find(
        (a) =>
          a.kind === "visual" &&
          a.assetId === shot.visualAsset.assetId &&
          a.assetVersionId === shot.visualAsset.assetVersionId &&
          a.status === "OK"
      );
      const resolvedVisual = matched?.resolvedPath
        ? matched.resolvedPath
        : resolve(assetRoot, shot.visualAsset.path.replace(/^\//, ""));
      args.push("-loop", "1", "-t", String(shot.timing.durationSeconds), "-i", resolvedVisual);
    }

    // Inputs: Audio assets (use exact resolvedPath from integrity report)
    for (const track of tracks) {
      const matched = reportAssets.find(
        (a) => a.kind === "audio" && a.assetId === track.audioAssetId && a.status === "OK"
      );
      const resolvedAudio = matched?.resolvedPath
        ? matched.resolvedPath
        : resolve(assetRoot, track.path.replace(/^\//, ""));
      args.push("-i", resolvedAudio);
    }

    // Build filter_complex
    const filterParts: string[] = [];
    const videoStreams: string[] = [];

    for (let i = 0; i < shots.length; i++) {
      const vTag = `v${i}`;
      filterParts.push(
        `[${i}:v]scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,` +
        `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,` +
        `setsar=1,fps=${canvas.frameRate}[${vTag}]`
      );
      videoStreams.push(`[${vTag}]`);
    }

    // Concat video streams if multiple shots
    let finalVideoTag = "[v0]";
    if (shots.length > 1) {
      const concatFilter = `${videoStreams.join("")}concat=n=${shots.length}:v=1:a=0[vconcat]`;
      filterParts.push(concatFilter);
      finalVideoTag = "[vconcat]";
    }

    // Audio stream mixing/concat
    let hasAudio = false;
    let finalAudioTag = "";
    if (tracks.length > 0) {
      hasAudio = true;
      const audioStreams: string[] = [];
      for (let i = 0; i < tracks.length; i++) {
        const audioInputIndex = shots.length + i;
        const aTag = `a${i}`;
        const delayMs = Math.round(tracks[i].startSeconds * 1000);
        if (delayMs > 0) {
          filterParts.push(`[${audioInputIndex}:a]adelay=${delayMs}|${delayMs}[${aTag}]`);
        } else {
          filterParts.push(`[${audioInputIndex}:a]anull[${aTag}]`);
        }
        audioStreams.push(`[${aTag}]`);
      }

      if (tracks.length > 1) {
        filterParts.push(`${audioStreams.join("")}amix=inputs=${tracks.length}:duration=longest[amixout]`);
        finalAudioTag = "[amixout]";
      } else {
        finalAudioTag = audioStreams[0];
      }
    }

    args.push("-filter_complex", filterParts.join("; "));
    args.push("-map", finalVideoTag);
    if (hasAudio) {
      args.push("-map", finalAudioTag);
      args.push("-c:a", "aac");
    }

    args.push(
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-r", String(canvas.frameRate),
      "-t", String(composition.durationSeconds),
      outputPath
    );

    return args;
  }

  private async computeSha256(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return hash.digest("hex");
  }

  private async safeRemove(filePath: string): Promise<void> {
    try {
      await rm(filePath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
