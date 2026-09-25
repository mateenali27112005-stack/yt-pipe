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
import { access, rename, rm, stat, writeFile } from "node:fs/promises";
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

export interface ProcessOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  killSignal?: NodeJS.Signals | number;
}

export type ProcessRunner = (
  command: string,
  args: string[],
  options?: ProcessOptions
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

export type ProbeRunner = (filePath: string, options?: ProcessOptions) => Promise<ProbeResult>;

/** Production process runner using child_process.execFile with timeout and maxBuffer bounds */
export const defaultProcessRunner: ProcessRunner = async (command, args, options) => {
  const timeout = options?.timeoutMs ?? 30000;
  const maxBuffer = options?.maxBufferBytes ?? 10 * 1024 * 1024;
  const killSignal = options?.killSignal ?? "SIGKILL";

  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
      timeout,
      maxBuffer,
      killSignal,
    });
    return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: any) {
    const isTimeout = err.killed && (err.signal === killSignal || err.code === "ETIMEDOUT");
    const isMaxBuffer = err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    let stderrMsg = err.stderr ?? err.message ?? "Process execution failed";
    if (isTimeout) {
      stderrMsg = `Subprocess execution timed out after ${timeout}ms (killed with ${killSignal}): ${stderrMsg}`;
    } else if (isMaxBuffer) {
      stderrMsg = `Subprocess output buffer exceeded maxBuffer limit (${maxBuffer} bytes): ${stderrMsg}`;
    }
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: stderrMsg,
    };
  }
};

/** Production probe runner using ffprobe JSON output with timeout protection */
export const defaultProbeRunner: ProbeRunner = async (filePath, options) => {
  const timeoutMs = options?.timeoutMs ?? 10000;
  const args = [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ];
  const { exitCode, stdout, stderr } = await defaultProcessRunner("ffprobe", args, {
    ...options,
    timeoutMs,
  });
  if (exitCode !== 0 || !stdout) {
    throw new Error(`FFprobe failed on file: ${filePath} (${stderr || "exit code " + exitCode})`);
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
  /** Timeout in milliseconds for FFmpeg process execution (default: 30000ms) */
  processTimeoutMs?: number;
  /** Timeout in milliseconds for FFprobe probing execution (default: 10000ms) */
  probeTimeoutMs?: number;
  /** Maximum stdout/stderr buffer size in bytes for subprocesses (default: 10MB) */
  maxBufferBytes?: number;
}

export class FFmpegRenderer implements Renderer {
  readonly rendererVersion = "FFmpegRenderer/1.0";
  private readonly processRunner: ProcessRunner;
  private readonly probeRunner: ProbeRunner;
  private readonly ffmpegPath: string;
  private readonly ffprobePath: string;
  private readonly durationTolerance: number;
  private readonly processTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(options: FFmpegRendererOptions = {}) {
    this.processRunner = options.processRunner ?? defaultProcessRunner;
    this.probeRunner = options.probeRunner ?? defaultProbeRunner;
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.ffprobePath = options.ffprobePath ?? "ffprobe";
    this.durationTolerance = options.durationToleranceSeconds ?? 0.5;
    this.processTimeoutMs = options.processTimeoutMs ?? 30000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 10000;
    this.maxBufferBytes = options.maxBufferBytes ?? 10 * 1024 * 1024;
  }

  async render(composition: FinalCompositionSpec, context: RenderContext): Promise<RenderResult> {
    // 1. Enforce preconditions (throws RenderError for contract violations)
    assertRenderPreconditions(composition, context);

    const normalizedOutput = normalize(resolve(context.outputPath));
    const normalizedRoot = normalize(resolve(context.assetRoot));

    const procOptions: ProcessOptions = {
      timeoutMs: this.processTimeoutMs,
      maxBufferBytes: this.maxBufferBytes,
    };
    const probeOptions: ProcessOptions = {
      timeoutMs: this.probeTimeoutMs,
      maxBufferBytes: this.maxBufferBytes,
    };

    // 2. Verify binary availability
    const ffmpegCheck = await this.processRunner(this.ffmpegPath, ["-version"], procOptions);
    if (ffmpegCheck.exitCode !== 0) {
      return {
        status: "FAILED",
        reason: `FFmpeg executable '${this.ffmpegPath}' is unavailable or failed execution check.`,
      };
    }
    const ffprobeCheck = await this.processRunner(this.ffprobePath, ["-version"], probeOptions);
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
    let stagingSubPath: string | undefined = undefined;

    try {
      // 4. Generate WebVTT caption file if captions are present
      if (composition.captions && composition.captions.length > 0) {
        stagingSubPath = join(targetDir, `.render_staging_${tmpSuffix}.vtt`);
        const vttContent = this.generateWebVTT(composition.captions);
        await writeFile(stagingSubPath, vttContent, "utf8");
      }

      // 5. Construct FFmpeg arguments using exact resolved paths from IntegrityReport
      const ffmpegArgs = this.buildFFmpegArgs(
        composition,
        context.integrityReport.assets,
        normalizedRoot,
        stagingOutput,
        stagingSubPath
      );

      // 6. Execute FFmpeg
      const renderProc = await this.processRunner(this.ffmpegPath, ffmpegArgs, procOptions);
      if (renderProc.exitCode !== 0) {
        await this.safeRemove(stagingOutput);
        await this.safeRemove(stagingSubPath);
        const reasonMsg = renderProc.stderr.includes("timed out")
          ? renderProc.stderr
          : `FFmpeg process exited with code ${renderProc.exitCode}: ${renderProc.stderr || renderProc.stdout}`;
        return {
          status: "FAILED",
          reason: reasonMsg,
        };
      }

      // 7. Post-render verification
      try {
        await access(stagingOutput);
      } catch {
        await this.safeRemove(stagingOutput);
        await this.safeRemove(stagingSubPath);
        return {
          status: "FAILED",
          reason: `FFmpeg output file missing after rendering: ${stagingOutput}`,
        };
      }

      const fileStat = await stat(stagingOutput);
      if (fileStat.size === 0) {
        await this.safeRemove(stagingOutput);
        await this.safeRemove(stagingSubPath);
        return {
          status: "FAILED",
          reason: `FFmpeg output file is empty (0 bytes): ${stagingOutput}`,
        };
      }

      // Probe rendered output
      let probed: ProbeResult;
      try {
        probed = await this.probeRunner(stagingOutput, probeOptions);
      } catch (err: any) {
        await this.safeRemove(stagingOutput);
        await this.safeRemove(stagingSubPath);
        return {
          status: "FAILED",
          reason: `Post-render FFprobe verification failed: ${err.message ?? err}`,
          cause: err instanceof Error ? err : undefined,
        };
      }

      // Verify duration
      if (typeof probed.durationSeconds !== "number" || isNaN(probed.durationSeconds)) {
        await this.safeRemove(stagingOutput);
        await this.safeRemove(stagingSubPath);
        return {
          status: "FAILED",
          reason: "Post-render verification failed: probed duration is undefined or invalid.",
        };
      }

      const durationDiff = Math.abs(probed.durationSeconds - composition.durationSeconds);
      if (durationDiff > this.durationTolerance) {
        await this.safeRemove(stagingOutput);
        await this.safeRemove(stagingSubPath);
        return {
          status: "FAILED",
          reason: `Post-render duration mismatch: expected ${composition.durationSeconds}s ±${this.durationTolerance}s, got ${probed.durationSeconds}s (diff: ${durationDiff.toFixed(3)}s).`,
        };
      }

      // Verify video stream presence & canvas dimensions
      if (!probed.videoStream) {
        await this.safeRemove(stagingOutput);
        await this.safeRemove(stagingSubPath);
        return {
          status: "FAILED",
          reason: "Post-render verification failed: output file contains no video stream.",
        };
      }
      const canvas = composition.visualComposition.canvas;
      if (probed.videoStream.width && probed.videoStream.width !== canvas.width) {
        await this.safeRemove(stagingOutput);
        await this.safeRemove(stagingSubPath);
        return {
          status: "FAILED",
          reason: `Post-render video width mismatch: expected ${canvas.width}, got ${probed.videoStream.width}.`,
        };
      }
      if (probed.videoStream.height && probed.videoStream.height !== canvas.height) {
        await this.safeRemove(stagingOutput);
        await this.safeRemove(stagingSubPath);
        return {
          status: "FAILED",
          reason: `Post-render video height mismatch: expected ${canvas.height}, got ${probed.videoStream.height}.`,
        };
      }

      // Verify audio stream if narration/dialogue tracks exist
      const totalAudioTracks = composition.narrationDialogueTracks.length +
        (composition.musicCues ?? []).filter(c => c.path).length +
        (composition.sfxCues ?? []).filter(c => c.path).length;

      if (totalAudioTracks > 0 && !probed.audioStream) {
        await this.safeRemove(stagingOutput);
        await this.safeRemove(stagingSubPath);
        return {
          status: "FAILED",
          reason: "Post-render verification failed: composition has narration/audio tracks but output contains no audio stream.",
        };
      }

      // 8. Compute final hashes & byte length
      const actualByteLength = fileStat.size;
      const actualSha256 = await this.computeSha256(stagingOutput);

      // 9. Atomic move staging → final outputPath
      await rename(stagingOutput, normalizedOutput);
      await this.safeRemove(stagingSubPath);

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
      await this.safeRemove(stagingSubPath);
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
    outputPath: string,
    stagingSubPath?: string
  ): string[] {
    const canvas = composition.visualComposition.canvas;
    const shots = composition.visualComposition.shots;

    // Collect all realized audio tracks: narration dialogue tracks + realized music & sfx cues
    const audioTracks: Array<{ audioAssetId?: string; path: string; startSeconds: number; gainDb: number }> = [
      ...composition.narrationDialogueTracks.map(t => ({ audioAssetId: t.audioAssetId, path: t.path, startSeconds: t.startSeconds, gainDb: t.gainDb })),
      ...(composition.musicCues ?? []).filter(c => c.path).map(c => ({ audioAssetId: c.audioAssetId, path: c.path!, startSeconds: c.startSeconds, gainDb: c.gainDb })),
      ...(composition.sfxCues ?? []).filter(c => c.path).map(c => ({ audioAssetId: c.audioAssetId, path: c.path!, startSeconds: c.startSeconds, gainDb: c.gainDb })),
    ];

    const args: string[] = ["-y"]; // Overwrite staging file if it exists

    // Inputs: Visual assets (use exact resolvedPath from integrity report)
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const nextShot = i + 1 < shots.length ? shots[i + 1] : undefined;
      const crossfadeDuration = (nextShot?.transitionIn?.type === "CROSSFADE" && nextShot.transitionIn.durationSeconds > 0)
        ? nextShot.transitionIn.durationSeconds
        : 0;

      // Extend shot input duration by crossfade overlap if next shot crossfades
      const shotRenderDuration = shot.timing.durationSeconds + crossfadeDuration;

      const matchedVisual = reportAssets.find(
        (a) =>
          a.kind === "visual" &&
          a.assetId === shot.visualAsset.assetId &&
          a.assetVersionId === shot.visualAsset.assetVersionId &&
          a.status === "OK"
      );
      if (!matchedVisual?.resolvedPath) {
        throw new Error(
          `Internal: no verified resolvedPath for visual asset '${shot.visualAsset.assetId}' ` +
          `(version '${shot.visualAsset.assetVersionId}'). assertRenderPreconditions should have caught this.`
        );
      }
      args.push("-loop", "1", "-t", String(shotRenderDuration), "-i", matchedVisual.resolvedPath);
    }

    // Inputs: Audio assets — resolvedPath must be present; assertRenderPreconditions guarantees this
    for (const track of audioTracks) {
      const matchedAudio = reportAssets.find(
        (a) => a.kind === "audio" && track.audioAssetId != null && a.assetId === track.audioAssetId && a.status === "OK"
      );
      if (!matchedAudio?.resolvedPath) {
        throw new Error(
          `Internal: no verified resolvedPath for audio asset '${track.audioAssetId ?? track.path}'. ` +
          `assertRenderPreconditions should have caught this.`
        );
      }
      args.push("-i", matchedAudio.resolvedPath);
    }

    // Build filter_complex
    const filterParts: string[] = [];
    const videoStreamTags: string[] = [];

    // 1. Visual Filters: Camera motion (zoom/pan) per shot
    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const nextShot = i + 1 < shots.length ? shots[i + 1] : undefined;
      const crossfadeDuration = (nextShot?.transitionIn?.type === "CROSSFADE" && nextShot.transitionIn.durationSeconds > 0)
        ? nextShot.transitionIn.durationSeconds
        : 0;
      const shotRenderDuration = shot.timing.durationSeconds + crossfadeDuration;
      const totalFrames = Math.max(1, Math.round(shotRenderDuration * canvas.frameRate));

      const vTag = `v_cam_${i}`;
      const k0 = shot.camera.keyframes[0] ?? { offset: 0, scale: 1, x: 0.5, y: 0.5 };
      const k1 = shot.camera.keyframes[1] ?? { offset: 1, scale: 1, x: 0.5, y: 0.5 };

      const isStatic = k0.scale === k1.scale && k0.x === k1.x && k0.y === k1.y;

      let cameraFilter: string;
      if (isStatic) {
        if (k0.scale === 1 && k0.x === 0.5 && k0.y === 0.5) {
          cameraFilter = `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,` +
            `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${canvas.frameRate}`;
        } else {
          cameraFilter = `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,` +
            `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
            `zoompan=z='${k0.scale}':x='(iw-iw/zoom)*${k0.x}':y='(ih-ih/zoom)*${k0.y}':d=${totalFrames}:s=${canvas.width}x${canvas.height}:fps=${canvas.frameRate},setsar=1`;
        }
      } else {
        const denom = Math.max(1, totalFrames - 1);
        const scaleDiff = parseFloat((k1.scale - k0.scale).toFixed(6));
        const xDiff = parseFloat((k1.x - k0.x).toFixed(6));
        const yDiff = parseFloat((k1.y - k0.y).toFixed(6));

        const zExpr = `${k0.scale}+(${scaleDiff})*(on-1)/${denom}`;
        const xExpr = `(iw-iw/zoom)*(${k0.x}+(${xDiff})*(on-1)/${denom})`;
        const yExpr = `(ih-ih/zoom)*(${k0.y}+(${yDiff})*(on-1)/${denom})`;

        cameraFilter = `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,` +
          `pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
          `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=${totalFrames}:s=${canvas.width}x${canvas.height}:fps=${canvas.frameRate},setsar=1`;
      }

      filterParts.push(`[${i}:v]${cameraFilter}[${vTag}]`);
      videoStreamTags.push(`[${vTag}]`);
    }

    // 2. Shot Sequencing & Transitions (chaining CUTs and CROSSFADEs)
    let currentAccTag = videoStreamTags[0];
    let currentAccDuration = shots[0].timing.durationSeconds;

    for (let i = 1; i < shots.length; i++) {
      const shot = shots[i];
      const nextAccTag = `[v_seq_${i}]`;
      const transitionIn = shot.transitionIn;
      const crossfadeDur = (transitionIn?.type === "CROSSFADE" && transitionIn.durationSeconds > 0)
        ? transitionIn.durationSeconds
        : 0;

      if (crossfadeDur > 0) {
        const offset = Math.max(0, currentAccDuration - crossfadeDur);
        filterParts.push(
          `${currentAccTag}${videoStreamTags[i]}xfade=transition=fade:duration=${crossfadeDur}:offset=${offset}${nextAccTag}`
        );
      } else {
        filterParts.push(
          `${currentAccTag}${videoStreamTags[i]}concat=n=2:v=1:a=0${nextAccTag}`
        );
      }

      currentAccTag = nextAccTag;
      currentAccDuration += shot.timing.durationSeconds;
    }

    // 3. Captions Subtitle Burn-In Filter
    let finalVideoTag = currentAccTag;
    if (stagingSubPath) {
      const escapedSubPath = stagingSubPath.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
      const subTag = "[v_subtitles]";
      filterParts.push(
        `${currentAccTag}subtitles='${escapedSubPath}':force_style='FontSize=20,PrimaryColour=&H00FFFFFF,BackColour=&H80000000,BorderStyle=4,Alignment=2'${subTag}`
      );
      finalVideoTag = subTag;
    }

    // 4. Audio Stream Mixing (Narration + Music + SFX with gainDb & timing)
    let hasAudio = false;
    let finalAudioTag = "";
    if (audioTracks.length > 0) {
      hasAudio = true;
      const audioStreams: string[] = [];
      for (let i = 0; i < audioTracks.length; i++) {
        const track = audioTracks[i];
        const audioInputIndex = shots.length + i;
        const aTag = `[a_mix_${i}]`;
        const delayMs = Math.round(track.startSeconds * 1000);

        const volumeFilter = track.gainDb !== 0 ? `,volume=${track.gainDb}dB` : "";
        const delayFilter = delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : "";

        filterParts.push(`[${audioInputIndex}:a]anull${volumeFilter}${delayFilter}${aTag}`);
        audioStreams.push(aTag);
      }

      if (audioStreams.length > 1) {
        filterParts.push(
          `${audioStreams.join("")}amix=inputs=${audioStreams.length}:duration=longest:normalize=0,atrim=0:${composition.durationSeconds}[amixout]`
        );
        finalAudioTag = "[amixout]";
      } else {
        filterParts.push(`${audioStreams[0]}atrim=0:${composition.durationSeconds},apad[aout_single]`);
        finalAudioTag = "[aout_single]";
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

  private generateWebVTT(captions: FinalCompositionSpec["captions"]): string {
    const lines: string[] = ["WEBVTT", ""];
    captions.forEach((cap, idx) => {
      lines.push(String(idx + 1));
      lines.push(`${this.formatVTTTime(cap.startSeconds)} --> ${this.formatVTTTime(cap.endSeconds)}`);
      const speakerPrefix = cap.speaker ? `${cap.speaker}: ` : "";
      lines.push(`${speakerPrefix}${cap.text}`);
      lines.push("");
    });
    return lines.join("\n");
  }

  private formatVTTTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    const pad = (n: number, z = 2) => String(n).padStart(z, "0");
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
  }

  private async computeSha256(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    return hash.digest("hex");
  }

  private async safeRemove(filePath?: string): Promise<void> {
    if (!filePath) return;
    try {
      await rm(filePath, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

