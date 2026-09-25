/**
 * V0.7 — QC & Shot Repair Agent: Type Contracts
 *
 * Defines the typed domain model for shot-level quality control results and
 * repair decisions. All types are pure — no I/O, no side effects.
 *
 * QC operates at the SHOT level, examining both the visual asset (PNG image)
 * and the associated audio asset (AIFF narration/dialogue) independently.
 * The combined result for a shot drives the repair decision.
 *
 * Repair decisions are deterministic given a ShotQCResult — they do NOT
 * depend on wall time, external APIs, or any mutable state.
 */

// ---------------------------------------------------------------------------
// Visual QC
// ---------------------------------------------------------------------------

/** Reasons a visual asset (PNG frame) may fail QC. */
export type VisualQCFailureReason =
  | "BLACK_FRAME"        // Mean pixel luminance below threshold — likely render failure
  | "NEAR_BLACK_FRAME"   // Low but non-zero luminance — warn, do not auto-fail
  | "OVERSATURATED"      // Mean saturation above ceiling — AI colour artifact
  | "WRONG_DIMENSIONS"   // Image width/height do not match the canvas spec
  | "FORMAT_ERROR"       // File is not a valid PNG (bad header / corrupt)
  | "MISSING_FILE";      // File does not exist on disk

/** Per-pixel luminance statistics computed from the raw PNG bytes. */
export interface LuminanceStats {
  /** Mean luminance across all pixels, 0.0 (black) – 1.0 (white). */
  mean: number;
  /** Fraction of pixels with luminance below BLACK_PIXEL_THRESHOLD (0.0–1.0). */
  darkPixelFraction: number;
  /** Sample size (total number of pixels examined). */
  samplePixels: number;
}

export interface VisualQCResult {
  shotId: string;
  assetId: string;
  assetVersionId: string;
  status: "PASS" | "WARN" | "FAIL";
  reasons: VisualQCFailureReason[];
  /** Populated when the PNG was successfully decoded. */
  luminance?: LuminanceStats;
  /** Actual image dimensions found on disk; undefined if file was unreadable. */
  actualWidth?: number;
  actualHeight?: number;
  /** Expected canvas dimensions from the composition spec. */
  expectedWidth: number;
  expectedHeight: number;
}

// ---------------------------------------------------------------------------
// Audio QC
// ---------------------------------------------------------------------------

/** Reasons an audio asset (AIFF file) may fail QC. */
export type AudioQCFailureReason =
  | "FULL_SILENCE"        // Entire track is below silence threshold — likely TTS failure
  | "LEADING_SILENCE"     // Significant silence at track start (> threshold seconds)
  | "TRAILING_SILENCE"    // Significant silence at track end (> threshold seconds)
  | "CLIPPING_DETECTED"   // Samples at or above 0 dBFS — distortion risk
  | "DURATION_SHORT"      // Realized duration is significantly shorter than spec
  | "DURATION_LONG"       // Realized duration is significantly longer than spec
  | "FORMAT_ERROR"        // File is not a parseable AIFF container
  | "MISSING_FILE";       // File does not exist on disk

/** Raw amplitude statistics sampled from AIFF PCM data. */
export interface AmplitudeStats {
  /** RMS amplitude, 0.0 (silence) – 1.0 (full scale). */
  rms: number;
  /** Peak absolute amplitude, 0.0 – 1.0. */
  peak: number;
  /** Fraction of samples below SILENCE_SAMPLE_THRESHOLD (0.0 – 1.0). */
  silentSampleFraction: number;
  /** Measured duration in seconds based on frame count / sample rate. */
  measuredDurationSeconds: number;
  /** Sample count used for analysis. */
  sampleCount: number;
}

export interface AudioQCResult {
  shotId: string;
  assetId: string;
  status: "PASS" | "WARN" | "FAIL";
  reasons: AudioQCFailureReason[];
  /** Populated when the AIFF was successfully parsed. */
  amplitude?: AmplitudeStats;
  /** Duration declared in the composition spec for this track (seconds). */
  expectedDurationSeconds: number;
}

// ---------------------------------------------------------------------------
// Shot-level combined result
// ---------------------------------------------------------------------------

/**
 * The combined QC verdict for one shot.
 * A shot FAILs if either the visual or audio result is FAIL.
 * A shot WARNs if either is WARN (and neither is FAIL).
 */
export interface ShotQCResult {
  shotId: string;
  status: "PASS" | "WARN" | "FAIL";
  visual: VisualQCResult;
  audio: AudioQCResult;
}

// ---------------------------------------------------------------------------
// Episode-level QC report
// ---------------------------------------------------------------------------

export interface EpisodeQCReport {
  schemaVersion: "0.1";
  episodeId: string;
  compositionVersion: number;
  checkedAt: string;
  /** Overall episode QC verdict — PASS only if all shots PASS. */
  status: "PASS" | "WARN" | "FAIL";
  totalShots: number;
  passedShots: number;
  warnedShots: number;
  failedShots: number;
  shots: ShotQCResult[];
}

// ---------------------------------------------------------------------------
// Repair decision
// ---------------------------------------------------------------------------

/**
 * What the repair agent should do with a failed/warned shot.
 *
 * RETRY_VISUAL   — re-generate the image via the image provider
 * RETRY_AUDIO    — re-generate the TTS audio via the speech provider
 * RETRY_BOTH     — re-generate image AND audio
 * SKIP           — mark the shot as acceptable despite warnings (WARN-only shots)
 * ESCALATE       — failure is beyond automated repair; require human review
 */
export type RepairAction =
  | "RETRY_VISUAL"
  | "RETRY_AUDIO"
  | "RETRY_BOTH"
  | "SKIP"
  | "ESCALATE";

export interface ShotRepairDecision {
  shotId: string;
  action: RepairAction;
  /** Human-readable rationale for audit logs. */
  rationale: string;
  /** Which visual failure reasons drove this decision (if any). */
  visualReasons: VisualQCFailureReason[];
  /** Which audio failure reasons drove this decision (if any). */
  audioReasons: AudioQCFailureReason[];
}

// ---------------------------------------------------------------------------
// Repair result
// ---------------------------------------------------------------------------

/** Outcome of attempting to repair a single shot. */
export type RepairOutcome =
  | "REPAIRED"        // Shot now passes QC after repair
  | "STILL_FAILING"   // Shot was re-generated but still fails QC
  | "SKIPPED"         // Decision was SKIP — no repair attempted
  | "ESCALATED"       // Decision was ESCALATE — flagged for human review
  | "ERROR";          // Repair attempt threw an unexpected error

export interface ShotRepairResult {
  shotId: string;
  decision: ShotRepairDecision;
  outcome: RepairOutcome;
  /** If REPAIRED: the post-repair QC result. */
  postRepairQC?: ShotQCResult;
  /** If ERROR: the error message. */
  errorMessage?: string;
  /** ISO 8601 timestamp of when the repair was attempted. */
  repairedAt: string;
}

export interface EpisodeRepairReport {
  schemaVersion: "0.1";
  episodeId: string;
  repairedAt: string;
  /** Overall repair status — CLEAN if all repairs passed or were skipped. */
  status: "CLEAN" | "PARTIAL" | "FAILED" | "NEEDS_REVIEW";
  totalRepairs: number;
  repaired: number;
  stillFailing: number;
  skipped: number;
  escalated: number;
  errors: number;
  results: ShotRepairResult[];
}

// ---------------------------------------------------------------------------
// QC Thresholds (configurable, with safe defaults)
// ---------------------------------------------------------------------------

export interface QCThresholds {
  /**
   * Mean pixel luminance below which a frame is classified as BLACK_FRAME.
   * Range: 0.0 – 1.0. Default: 0.02 (2% brightness).
   */
  blackFrameThreshold: number;

  /**
   * Mean pixel luminance below which a frame is classified as NEAR_BLACK_FRAME (WARN).
   * Must be >= blackFrameThreshold. Default: 0.05.
   */
  nearBlackFrameThreshold: number;

  /**
   * Mean pixel saturation above which a frame triggers OVERSATURATED (WARN).
   * Range: 0.0 – 1.0. Default: 0.95.
   */
  oversaturationThreshold: number;

  /**
   * RMS amplitude below which an entire audio track is classified as FULL_SILENCE.
   * Range: 0.0 – 1.0. Default: 0.001.
   */
  silenceRmsThreshold: number;

  /**
   * Per-sample amplitude below which a sample is counted as "silent"
   * (used for leading/trailing silence detection). Default: 0.005.
   */
  silenceSampleThreshold: number;

  /**
   * Fraction of silent samples at the START of a track to trigger LEADING_SILENCE (WARN).
   * Default: 0.15 (15% of total samples).
   */
  leadingSilenceThreshold: number;

  /**
   * Fraction of silent samples at the END of a track to trigger TRAILING_SILENCE (WARN).
   * Default: 0.15.
   */
  trailingSilenceThreshold: number;

  /**
   * Peak amplitude at or above which CLIPPING_DETECTED is raised (WARN).
   * Range: 0.0 – 1.0. Default: 0.99 (near-full-scale).
   */
  clippingThreshold: number;

  /**
   * Fraction of measured vs. expected duration below which DURATION_SHORT triggers (FAIL).
   * Default: 0.8 (measured < 80% of expected).
   */
  durationShortFraction: number;

  /**
   * Fraction of measured vs. expected duration above which DURATION_LONG triggers (WARN).
   * Default: 1.3 (measured > 130% of expected).
   */
  durationLongFraction: number;
}

export const DEFAULT_QC_THRESHOLDS: QCThresholds = {
  blackFrameThreshold: 0.02,
  nearBlackFrameThreshold: 0.05,
  oversaturationThreshold: 0.95,
  silenceRmsThreshold: 0.001,
  silenceSampleThreshold: 0.005,
  leadingSilenceThreshold: 0.15,
  trailingSilenceThreshold: 0.15,
  clippingThreshold: 0.99,
  durationShortFraction: 0.8,
  durationLongFraction: 1.3,
};
