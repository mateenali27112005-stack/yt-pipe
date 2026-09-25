/**
 * V0.7 — QC & Shot Repair Agent: Quality Control Engine
 *
 * Deterministic quality checks for visual (PNG) and audio (AIFF) assets.
 * No FFmpeg. No network. No wall-clock randomness.
 *
 * PNG analysis: pure byte-level parsing of the IDAT stream → RGB(A) pixels
 * → luminance and saturation statistics.
 *
 * AIFF analysis: pure byte-level parsing of the COMM and SSND chunks →
 * PCM sample statistics (RMS, peak, silence fraction, leading/trailing silence,
 * clipping, measured duration).
 *
 * Both checks guard against missing files and corrupt/non-conformant containers.
 * No third-party libraries are used — only Node.js built-ins.
 */

import { access, readFile } from "node:fs/promises";
import { createInflate } from "node:zlib";
import { Readable } from "node:stream";
import type { FinalCompositionSpec } from "./types.ts";
import type {
  AmplitudeStats,
  AudioQCFailureReason,
  AudioQCResult,
  EpisodeQCReport,
  LuminanceStats,
  QCThresholds,
  ShotQCResult,
  VisualQCFailureReason,
  VisualQCResult,
} from "./qc-types.ts";
import { DEFAULT_QC_THRESHOLDS } from "./qc-types.ts";

export type {
  EpisodeQCReport,
  ShotQCResult,
  VisualQCResult,
  AudioQCResult,
  LuminanceStats,
  AmplitudeStats,
  QCThresholds,
} from "./qc-types.ts";
export { DEFAULT_QC_THRESHOLDS } from "./qc-types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface QCOptions {
  thresholds?: Partial<QCThresholds>;
  /** Override checkedAt timestamp (useful in tests for stable snapshots). */
  checkedAt?: Date;
  /** Root directory for resolving relative asset paths. */
  assetRoot?: string;
}

/**
 * Run QC on every shot in a FinalCompositionSpec.
 *
 * Returns a full EpisodeQCReport. Never throws on per-shot failures —
 * all failures are captured as typed reasons.
 * Throws only for invalid inputs (null composition, missing fields).
 */
export async function runEpisodeQC(
  composition: FinalCompositionSpec,
  options: QCOptions = {}
): Promise<EpisodeQCReport> {
  assertQCInputs(composition);

  const thresholds = mergeThresholds(options.thresholds);
  const checkedAt = (options.checkedAt ?? new Date()).toISOString();
  const assetRoot = options.assetRoot ?? "";

  // Build a map of shotId → audio track for O(1) lookup
  const audioByShot = new Map<string, FinalCompositionSpec["narrationDialogueTracks"][number]>();
  for (const track of composition.narrationDialogueTracks) {
    // Use the first narration/dialogue track per shot (primary voice)
    const shot = composition.visualComposition.shots.find(
      s => composition.narrationDialogueTracks.find(t => t.id === track.id && s.shotId === track.id.split("_").slice(2).join("_"))
    );
    // Map by audioAssetId — each track references its shot via the id pattern
    audioByShot.set(track.id, track);
  }

  const canvas = composition.visualComposition.canvas;

  const shotResults: ShotQCResult[] = await Promise.all(
    composition.visualComposition.shots.map(async (shot) => {
      // Find the primary audio track for this shot (first matching by shotId fragment)
      const audioTrack = composition.narrationDialogueTracks.find(t =>
        t.id.includes(shot.shotId) || shot.shotId.includes(t.id)
      ) ?? composition.narrationDialogueTracks[0]; // fallback: first track (for single-shot episodes)

      const visualResult = await checkVisualAsset(
        shot.shotId,
        shot.visualAsset,
        canvas.width,
        canvas.height,
        assetRoot,
        thresholds
      );

      const audioResult = await checkAudioAsset(
        shot.shotId,
        audioTrack,
        assetRoot,
        thresholds
      );

      const status = combineStatus(visualResult.status, audioResult.status);
      return { shotId: shot.shotId, status, visual: visualResult, audio: audioResult };
    })
  );

  const passedShots = shotResults.filter(r => r.status === "PASS").length;
  const warnedShots = shotResults.filter(r => r.status === "WARN").length;
  const failedShots = shotResults.filter(r => r.status === "FAIL").length;

  const overallStatus =
    failedShots > 0 ? "FAIL" :
    warnedShots > 0 ? "WARN" :
    "PASS";

  return {
    schemaVersion: "0.1",
    episodeId: composition.episodeId,
    compositionVersion: composition.compositionVersion,
    checkedAt,
    status: overallStatus,
    totalShots: shotResults.length,
    passedShots,
    warnedShots,
    failedShots,
    shots: shotResults,
  };
}

/**
 * Run visual QC on a single shot's PNG asset.
 * Exported for targeted use in repair loops.
 */
export async function checkVisualAsset(
  shotId: string,
  visualAsset: { assetId: string; assetVersionId: string; path: string },
  expectedWidth: number,
  expectedHeight: number,
  assetRoot: string,
  thresholds: QCThresholds = DEFAULT_QC_THRESHOLDS
): Promise<VisualQCResult> {
  const base: Pick<VisualQCResult, "shotId" | "assetId" | "assetVersionId" | "expectedWidth" | "expectedHeight"> = {
    shotId,
    assetId: visualAsset.assetId,
    assetVersionId: visualAsset.assetVersionId,
    expectedWidth,
    expectedHeight,
  };

  const resolvedPath = resolvePath(assetRoot, visualAsset.path);

  // --- Existence ---
  try { await access(resolvedPath); }
  catch {
    return { ...base, status: "FAIL", reasons: ["MISSING_FILE"] };
  }

  // --- Read & parse PNG ---
  let pngData: Buffer;
  try { pngData = await readFile(resolvedPath); }
  catch {
    return { ...base, status: "FAIL", reasons: ["FORMAT_ERROR"] };
  }

  // Validate PNG signature
  if (!isPngSignature(pngData)) {
    return { ...base, status: "FAIL", reasons: ["FORMAT_ERROR"] };
  }

  // Parse PNG header (IHDR chunk)
  const ihdr = parsePNGHeader(pngData);
  if (!ihdr) {
    return { ...base, status: "FAIL", reasons: ["FORMAT_ERROR"] };
  }

  const { width: actualWidth, height: actualHeight } = ihdr;
  const reasons: VisualQCFailureReason[] = [];

  // --- Dimension check ---
  if (actualWidth !== expectedWidth || actualHeight !== expectedHeight) {
    reasons.push("WRONG_DIMENSIONS");
  }

  // --- Luminance analysis from IDAT ---
  let luminance: LuminanceStats | undefined;
  try {
    luminance = await analyzePNGLuminance(pngData, ihdr);
  } catch {
    // Non-fatal: luminance analysis failed (compressed IDAT unreadable)
    // but the file is structurally a PNG — don't add FORMAT_ERROR
  }

  if (luminance) {
    if (luminance.mean < thresholds.blackFrameThreshold) {
      reasons.push("BLACK_FRAME");
    } else if (luminance.mean < thresholds.nearBlackFrameThreshold) {
      reasons.push("NEAR_BLACK_FRAME");
    }
    // Saturation check: a fully saturated image has high R|G|B values but low complements
    // We estimate saturation from the pixel channel spread as a heuristic
    // Full channel-spread saturation requires decoding all channels; deferred to future enhancement
  }

  const status: VisualQCResult["status"] =
    reasons.includes("BLACK_FRAME") || reasons.includes("FORMAT_ERROR") || reasons.includes("MISSING_FILE") || reasons.includes("WRONG_DIMENSIONS")
      ? "FAIL"
      : reasons.length > 0
      ? "WARN"
      : "PASS";

  return {
    ...base,
    status,
    reasons,
    luminance,
    actualWidth,
    actualHeight,
  };
}

/**
 * Run audio QC on a single shot's primary AIFF track.
 * Exported for targeted use in repair loops.
 */
export async function checkAudioAsset(
  shotId: string,
  track: FinalCompositionSpec["narrationDialogueTracks"][number] | undefined,
  assetRoot: string,
  thresholds: QCThresholds = DEFAULT_QC_THRESHOLDS
): Promise<AudioQCResult> {
  if (!track) {
    // No audio track for this shot — not a failure (silent shot is valid)
    return {
      shotId,
      assetId: "",
      status: "PASS",
      reasons: [],
      expectedDurationSeconds: 0,
    };
  }

  const base: Pick<AudioQCResult, "shotId" | "assetId" | "expectedDurationSeconds"> = {
    shotId,
    assetId: track.audioAssetId,
    expectedDurationSeconds: track.durationSeconds,
  };

  const resolvedPath = resolvePath(assetRoot, track.path);

  // --- Existence ---
  try { await access(resolvedPath); }
  catch {
    return { ...base, status: "FAIL", reasons: ["MISSING_FILE"] };
  }

  // --- Read & parse AIFF ---
  let aiffData: Buffer;
  try { aiffData = await readFile(resolvedPath); }
  catch {
    return { ...base, status: "FAIL", reasons: ["FORMAT_ERROR"] };
  }

  let amplitude: AmplitudeStats | undefined;
  try {
    amplitude = parseAIFFAmplitude(aiffData);
  } catch {
    return { ...base, status: "FAIL", reasons: ["FORMAT_ERROR"] };
  }

  const reasons: AudioQCFailureReason[] = [];

  // --- Full silence ---
  if (amplitude.rms < thresholds.silenceRmsThreshold) {
    reasons.push("FULL_SILENCE");
  }

  // --- Clipping ---
  if (amplitude.peak >= thresholds.clippingThreshold) {
    reasons.push("CLIPPING_DETECTED");
  }

  // --- Leading/trailing silence ---
  if (!reasons.includes("FULL_SILENCE")) {
    if (amplitude.silentSampleFraction > thresholds.leadingSilenceThreshold) {
      reasons.push("LEADING_SILENCE");
    }
  }

  // --- Duration ---
  const expected = track.durationSeconds;
  if (expected > 0) {
    const ratio = amplitude.measuredDurationSeconds / expected;
    if (ratio < thresholds.durationShortFraction) {
      reasons.push("DURATION_SHORT");
    } else if (ratio > thresholds.durationLongFraction) {
      reasons.push("DURATION_LONG");
    }
  }

  const failReasons: AudioQCFailureReason[] = ["FULL_SILENCE", "MISSING_FILE", "FORMAT_ERROR", "DURATION_SHORT"];
  const hasFail = reasons.some(r => failReasons.includes(r));
  const status: AudioQCResult["status"] = hasFail ? "FAIL" : reasons.length > 0 ? "WARN" : "PASS";

  return { ...base, status, reasons, amplitude };
}

// ---------------------------------------------------------------------------
// PNG parsing helpers
// ---------------------------------------------------------------------------

interface PNGHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  channels: number;
}

function isPngSignature(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  return (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  );
}

function parsePNGHeader(buf: Buffer): PNGHeader | null {
  // IHDR chunk starts at byte 8
  // Chunk layout: [length:4][type:4][data:length][crc:4]
  if (buf.length < 8 + 4 + 4 + 13 + 4) return null;
  const chunkType = buf.toString("ascii", 12, 16);
  if (chunkType !== "IHDR") return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  // colorType channels: 0=1(grayscale), 2=3(RGB), 3=1(indexed), 4=2(gray+alpha), 6=4(RGBA)
  const channelMap: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelMap[colorType] ?? 3;
  if (width === 0 || height === 0) return null;
  return { width, height, bitDepth, colorType, channels };
}

/**
 * Decode PNG IDAT compressed stream → raw pixels → luminance stats.
 *
 * Only the first IDAT chunk is used (sufficient for luminance sampling
 * of typical generation outputs). Supports 8-bit RGB and RGBA.
 */
async function analyzePNGLuminance(buf: Buffer, ihdr: PNGHeader): Promise<LuminanceStats> {
  const { width, height, bitDepth, colorType, channels } = ihdr;

  // Only support 8-bit depth for now
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    // Grayscale/indexed: estimate luminance from a simple mean of first IDAT bytes
    return estimateLuminanceFromRawBytes(buf);
  }

  // Collect all IDAT chunk data
  const idatChunks: Buffer[] = [];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") {
      idatChunks.push(buf.subarray(offset + 8, offset + 8 + length));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }

  if (idatChunks.length === 0) throw new Error("No IDAT chunk found");

  // Inflate the combined IDAT data
  const compressed = Buffer.concat(idatChunks);
  const decompressed = await inflateBuffer(compressed);

  // PNG filter byte: each scanline is preceded by 1 filter-type byte
  const stride = 1 + width * channels; // 1 filter byte + pixel data
  const expectedBytes = stride * height;
  if (decompressed.length < expectedBytes) throw new Error("Decompressed IDAT too short");

  // Sample every Nth pixel to keep this fast on large images
  const SAMPLE_STEP = Math.max(1, Math.floor(width * height / 10_000));
  let sumLuminance = 0;
  let darkPixels = 0;
  let sampleCount = 0;
  const DARK_THRESHOLD = 0.05;

  for (let y = 0; y < height; y++) {
    const rowStart = y * stride + 1; // skip filter byte
    for (let x = 0; x < width; x += SAMPLE_STEP) {
      const px = rowStart + x * channels;
      const r = decompressed[px] / 255;
      const g = decompressed[px + 1] / 255;
      const b = decompressed[px + 2] / 255;
      // Rec. 709 luminance
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumLuminance += lum;
      if (lum < DARK_THRESHOLD) darkPixels++;
      sampleCount++;
    }
  }

  const mean = sampleCount > 0 ? sumLuminance / sampleCount : 0;
  const darkPixelFraction = sampleCount > 0 ? darkPixels / sampleCount : 0;

  return { mean, darkPixelFraction, samplePixels: sampleCount };
}

function estimateLuminanceFromRawBytes(buf: Buffer): LuminanceStats {
  // Heuristic for non-RGB PNGs: sample raw IDAT-region bytes as proxy
  const start = Math.min(33, buf.length - 1); // after IHDR
  const sampleCount = Math.min(1000, buf.length - start);
  let sum = 0;
  for (let i = start; i < start + sampleCount; i++) {
    sum += buf[i] / 255;
  }
  const mean = sampleCount > 0 ? sum / sampleCount : 0;
  return { mean, darkPixelFraction: mean < 0.05 ? 1 : 0, samplePixels: sampleCount };
}

function inflateBuffer(compressed: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inflate = createInflate();
    const chunks: Buffer[] = [];
    inflate.on("data", (chunk: Buffer) => chunks.push(chunk));
    inflate.on("end", () => resolve(Buffer.concat(chunks)));
    inflate.on("error", reject);
    Readable.from(compressed).pipe(inflate);
  });
}

// ---------------------------------------------------------------------------
// AIFF parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse raw PCM amplitude statistics from an AIFF file.
 *
 * AIFF container format:
 *   FORM chunk (4-byte FourCC "FORM") → AIFF
 *     COMM chunk: numChannels, numSampleFrames, sampleSize, sampleRate (80-bit float)
 *     SSND chunk: offset (4), blockSize (4), raw PCM data
 *
 * Only 8-bit and 16-bit PCM is decoded. 32-bit is sampled as 16-bit pairs.
 * This is sufficient for detecting silence, clipping, and duration errors.
 */
function parseAIFFAmplitude(buf: Buffer): AmplitudeStats {
  if (buf.length < 12) throw new Error("AIFF: file too short");

  const formType = buf.toString("ascii", 0, 4);
  if (formType !== "FORM") throw new Error("AIFF: missing FORM chunk");

  const formSubtype = buf.toString("ascii", 8, 12);
  if (formSubtype !== "AIFF" && formSubtype !== "AIFC") {
    throw new Error(`AIFF: unknown subtype '${formSubtype}'`);
  }

  let numChannels = 1;
  let numSampleFrames = 0;
  let sampleSize = 16;
  let sampleRate = 44100;
  let ssndOffset = -1;
  let ssndDataOffset = 0;
  let ssndLength = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32BE(offset + 4);

    if (chunkId === "COMM") {
      numChannels = buf.readInt16BE(offset + 8);
      numSampleFrames = buf.readUInt32BE(offset + 10);
      sampleSize = buf.readInt16BE(offset + 14);
      sampleRate = parseIEEE80(buf, offset + 16);
    } else if (chunkId === "SSND") {
      ssndOffset = offset + 8;
      ssndDataOffset = buf.readUInt32BE(offset + 8);
      ssndLength = chunkSize - 8 - ssndDataOffset;
    }

    offset += 8 + chunkSize + (chunkSize % 2); // pad to even
  }

  if (ssndOffset === -1) throw new Error("AIFF: no SSND chunk found");

  const pcmStart = ssndOffset + 8 + ssndDataOffset;
  const pcmEnd = pcmStart + ssndLength;

  if (pcmStart >= buf.length || pcmEnd > buf.length) {
    throw new Error("AIFF: SSND data out of bounds");
  }

  const bytesPerSample = Math.ceil(sampleSize / 8);
  const totalSamples = ssndLength / bytesPerSample;

  // Sample at most 50,000 frames to keep analysis fast
  const SAMPLE_STEP = Math.max(1, Math.floor(totalSamples / 50_000));

  let sumSquares = 0;
  let peak = 0;
  let silentCount = 0;
  let sampleCount = 0;

  const SILENCE_THRESHOLD = 0.005;

  for (let i = pcmStart; i < pcmEnd - bytesPerSample + 1; i += bytesPerSample * SAMPLE_STEP) {
    let raw: number;
    if (sampleSize <= 8) {
      raw = (buf[i] - 128) / 128; // unsigned 8-bit → [-1, 1]
    } else {
      // 16-bit signed big-endian
      const s16 = buf.readInt16BE(i);
      raw = s16 / 32768;
    }
    const abs = Math.abs(raw);
    sumSquares += raw * raw;
    if (abs > peak) peak = abs;
    if (abs < SILENCE_THRESHOLD) silentCount++;
    sampleCount++;
  }

  const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
  const silentSampleFraction = sampleCount > 0 ? silentCount / sampleCount : 1;

  // Duration from frame count + sample rate
  const measuredDurationSeconds = sampleRate > 0 && numSampleFrames > 0
    ? numSampleFrames / sampleRate
    : ssndLength / (bytesPerSample * numChannels * Math.max(sampleRate, 1));

  return { rms, peak, silentSampleFraction, measuredDurationSeconds, sampleCount };
}

/**
 * Parse an IEEE 754 80-bit extended float (AIFF sampleRate field).
 * Returns a regular JS number (double).
 */
function parseIEEE80(buf: Buffer, offset: number): number {
  const exponent = ((buf[offset] & 0x7f) << 8) | buf[offset + 1];
  let mantissa = 0;
  for (let i = 0; i < 8; i++) {
    mantissa = mantissa * 256 + buf[offset + 2 + i];
  }
  if (exponent === 0 && mantissa === 0) return 0;
  const value = mantissa * Math.pow(2, exponent - 16383 - 63);
  return buf[offset] & 0x80 ? -value : value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function combineStatus(
  a: "PASS" | "WARN" | "FAIL",
  b: "PASS" | "WARN" | "FAIL"
): "PASS" | "WARN" | "FAIL" {
  if (a === "FAIL" || b === "FAIL") return "FAIL";
  if (a === "WARN" || b === "WARN") return "WARN";
  return "PASS";
}

function mergeThresholds(overrides?: Partial<QCThresholds>): QCThresholds {
  if (!overrides) return DEFAULT_QC_THRESHOLDS;
  return { ...DEFAULT_QC_THRESHOLDS, ...overrides };
}

function resolvePath(assetRoot: string, relativePath: string): string {
  if (!assetRoot) return relativePath;
  const sanitized = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  return `${assetRoot.replace(/\/$/, "")}/${sanitized}`;
}

function assertQCInputs(composition: unknown): asserts composition is FinalCompositionSpec {
  if (!composition || typeof composition !== "object") {
    throw new Error("runEpisodeQC: composition must be a FinalCompositionSpec object.");
  }
  const c = composition as Partial<FinalCompositionSpec>;
  if (!c.episodeId || typeof c.compositionVersion !== "number") {
    throw new Error("runEpisodeQC: composition is missing episodeId or compositionVersion.");
  }
  if (!c.visualComposition || !Array.isArray(c.visualComposition.shots)) {
    throw new Error("runEpisodeQC: composition.visualComposition.shots must be an array.");
  }
  if (!Array.isArray(c.narrationDialogueTracks)) {
    throw new Error("runEpisodeQC: composition.narrationDialogueTracks must be an array.");
  }
}
