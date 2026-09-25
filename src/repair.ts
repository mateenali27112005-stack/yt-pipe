/**
 * V0.7 — QC & Shot Repair Agent: Repair Decision Engine + Executor
 *
 * Two-stage pipeline:
 *
 *   Stage 1 — decideRepairs(qcReport):
 *     Deterministic decision function. Given an EpisodeQCReport, returns
 *     one ShotRepairDecision per failed or warned shot. Pure — no I/O.
 *
 *   Stage 2 — executeRepairs(decisions, context):
 *     Injected provider executors perform the actual regeneration.
 *     After each repair, runs a single-shot QC pass to confirm success.
 *     Returns an EpisodeRepairReport.
 *
 * The repair executor accepts injectable ShotVisualRepairer and
 * ShotAudioRepairer callbacks. This keeps the core engine testable
 * without real image/TTS providers.
 *
 * Design rules:
 *   - ESCALATE when a shot fails the same QC check twice in a row
 *   - RETRY_VISUAL for BLACK_FRAME, WRONG_DIMENSIONS, FORMAT_ERROR, MISSING_FILE (visual)
 *   - RETRY_AUDIO for FULL_SILENCE, DURATION_SHORT, FORMAT_ERROR, MISSING_FILE (audio)
 *   - RETRY_BOTH when both visual and audio are failing
 *   - SKIP for WARN-only shots (near-black, clipping, leading/trailing silence, duration long)
 *   - ESCALATE for OVERSATURATED (aesthetic judgment — needs human review)
 */

import type { FinalCompositionSpec } from "./types.ts";
import { checkVisualAsset, checkAudioAsset, DEFAULT_QC_THRESHOLDS } from "./qc.ts";
import type { QCThresholds, ShotQCResult } from "./qc.ts";
import type {
  AudioQCFailureReason,
  EpisodeQCReport,
  EpisodeRepairReport,
  RepairAction,
  RepairOutcome,
  ShotRepairDecision,
  ShotRepairResult,
  VisualQCFailureReason,
} from "./qc-types.ts";

export type {
  ShotRepairDecision,
  ShotRepairResult,
  EpisodeRepairReport,
  RepairAction,
} from "./qc-types.ts";

// ---------------------------------------------------------------------------
// Repair provider interfaces
// ---------------------------------------------------------------------------

/**
 * Injectable visual shot repairer.
 * Implementations should re-call the image provider and write the new PNG
 * to the same path as the original, returning the new asset's SHA-256.
 */
export interface ShotVisualRepairer {
  repairVisual(shotId: string, assetPath: string): Promise<{ sha256: string; byteLength: number }>;
}

/**
 * Injectable audio shot repairer.
 * Implementations should re-call the TTS provider and write the new AIFF
 * to the same path, returning the measured duration.
 */
export interface ShotAudioRepairer {
  repairAudio(shotId: string, audioPath: string, text: string): Promise<{ durationSeconds: number }>;
}

export interface RepairContext {
  /** The composition spec — needed to resolve paths and pass to post-repair QC. */
  composition: FinalCompositionSpec;
  /** Root directory for resolving relative asset paths. */
  assetRoot?: string;
  /** QC thresholds to use for post-repair QC passes. */
  thresholds?: Partial<QCThresholds>;
  /** Injectable visual repairer. Required if any shots need RETRY_VISUAL or RETRY_BOTH. */
  visualRepairer?: ShotVisualRepairer;
  /** Injectable audio repairer. Required if any shots need RETRY_AUDIO or RETRY_BOTH. */
  audioRepairer?: ShotAudioRepairer;
  /** Override repairedAt timestamp (useful in tests). */
  repairedAt?: Date;
}

// ---------------------------------------------------------------------------
// Stage 1: Decide
// ---------------------------------------------------------------------------

const VISUAL_FAIL_REASONS = new Set<VisualQCFailureReason>([
  "BLACK_FRAME",
  "WRONG_DIMENSIONS",
  "FORMAT_ERROR",
  "MISSING_FILE",
]);

const VISUAL_ESCALATE_REASONS = new Set<VisualQCFailureReason>([
  "OVERSATURATED",
]);

const AUDIO_FAIL_REASONS = new Set<AudioQCFailureReason>([
  "FULL_SILENCE",
  "DURATION_SHORT",
  "FORMAT_ERROR",
  "MISSING_FILE",
]);

/**
 * Deterministic repair decision for each non-passing shot.
 * Returns one decision per shot that needs attention.
 * PASS shots are excluded from the output.
 */
export function decideRepairs(qcReport: EpisodeQCReport): ShotRepairDecision[] {
  const decisions: ShotRepairDecision[] = [];

  for (const shot of qcReport.shots) {
    if (shot.status === "PASS") continue;

    const visualFails = shot.visual.reasons.filter(r => VISUAL_FAIL_REASONS.has(r));
    const visualEscalates = shot.visual.reasons.filter(r => VISUAL_ESCALATE_REASONS.has(r));
    const audioFails = shot.audio.reasons.filter(r => AUDIO_FAIL_REASONS.has(r));

    const hasVisualFail = visualFails.length > 0 || visualEscalates.length > 0;
    const hasAudioFail = audioFails.length > 0;
    const isWarnOnly = shot.status === "WARN";

    let action: RepairAction;
    let rationale: string;

    if (isWarnOnly && !hasVisualFail && !hasAudioFail) {
      // Only warnings — no critical failures
      action = "SKIP";
      rationale = `Shot has warnings only (${[...shot.visual.reasons, ...shot.audio.reasons].join(", ")}). Acceptable for broadcast.`;
    } else if (visualEscalates.length > 0) {
      // Aesthetic failures require human review
      action = "ESCALATE";
      rationale = `Shot has aesthetic failure(s) requiring human review: ${visualEscalates.join(", ")}.`;
    } else if (hasVisualFail && hasAudioFail) {
      action = "RETRY_BOTH";
      rationale = `Shot has both visual failures (${visualFails.join(", ")}) and audio failures (${audioFails.join(", ")}). Both assets will be regenerated.`;
    } else if (hasVisualFail) {
      action = "RETRY_VISUAL";
      rationale = `Shot has visual failures: ${visualFails.join(", ")}. Image will be regenerated.`;
    } else if (hasAudioFail) {
      action = "RETRY_AUDIO";
      rationale = `Shot has audio failures: ${audioFails.join(", ")}. Audio will be regenerated.`;
    } else {
      // WARN-only but with no clear category — skip
      action = "SKIP";
      rationale = `Shot has marginal quality warnings. Accepted as-is.`;
    }

    decisions.push({
      shotId: shot.shotId,
      action,
      rationale,
      visualReasons: [...shot.visual.reasons] as VisualQCFailureReason[],
      audioReasons: [...shot.audio.reasons] as AudioQCFailureReason[],
    });
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Stage 2: Execute
// ---------------------------------------------------------------------------

/**
 * Execute repair decisions against the composition's assets.
 *
 * For each RETRY_* decision:
 *   1. Invokes the appropriate injected repairer.
 *   2. Runs a post-repair QC pass on the shot.
 *   3. Records REPAIRED or STILL_FAILING.
 *
 * For SKIP → records SKIPPED.
 * For ESCALATE → records ESCALATED.
 * If the repairer throws → records ERROR with the message.
 */
export async function executeRepairs(
  decisions: ShotRepairDecision[],
  context: RepairContext
): Promise<EpisodeRepairReport> {
  const { composition, assetRoot = "", repairedAt } = context;
  const thresholds = { ...DEFAULT_QC_THRESHOLDS, ...(context.thresholds ?? {}) };
  const now = (repairedAt ?? new Date()).toISOString();

  // Index composition data for fast lookup
  const shotByShot = new Map(composition.visualComposition.shots.map(s => [s.shotId, s]));
  const trackByShot = buildTrackByShot(composition);

  const results: ShotRepairResult[] = await Promise.all(
    decisions.map(async (decision): Promise<ShotRepairResult> => {
      const base: Pick<ShotRepairResult, "shotId" | "decision" | "repairedAt"> = {
        shotId: decision.shotId,
        decision,
        repairedAt: now,
      };

      if (decision.action === "SKIP") {
        return { ...base, outcome: "SKIPPED" };
      }

      if (decision.action === "ESCALATE") {
        return { ...base, outcome: "ESCALATED" };
      }

      // RETRY_VISUAL, RETRY_AUDIO, RETRY_BOTH
      const shot = shotByShot.get(decision.shotId);
      const track = trackByShot.get(decision.shotId);

      if (!shot) {
        return { ...base, outcome: "ERROR", errorMessage: `Shot '${decision.shotId}' not found in composition.` };
      }

      try {
        // Execute repair
        if ((decision.action === "RETRY_VISUAL" || decision.action === "RETRY_BOTH") && context.visualRepairer) {
          await context.visualRepairer.repairVisual(decision.shotId, resolvePath(assetRoot, shot.visualAsset.path));
        } else if (decision.action === "RETRY_VISUAL" || decision.action === "RETRY_BOTH") {
          return { ...base, outcome: "ERROR", errorMessage: "No visualRepairer provided in RepairContext." };
        }

        if ((decision.action === "RETRY_AUDIO" || decision.action === "RETRY_BOTH") && context.audioRepairer) {
          const text = track ? (track as any).text ?? "" : "";
          await context.audioRepairer.repairAudio(decision.shotId, track ? resolvePath(assetRoot, track.path) : "", text);
        } else if (decision.action === "RETRY_AUDIO" || decision.action === "RETRY_BOTH") {
          return { ...base, outcome: "ERROR", errorMessage: "No audioRepairer provided in RepairContext." };
        }

        // Post-repair QC
        const canvas = composition.visualComposition.canvas;
        const postVisual = await checkVisualAsset(
          decision.shotId,
          shot.visualAsset,
          canvas.width,
          canvas.height,
          assetRoot,
          thresholds
        );

        const postAudio = await checkAudioAsset(
          decision.shotId,
          track,
          assetRoot,
          thresholds
        );

        const postStatus = combineStatus(postVisual.status, postAudio.status);
        const postRepairQC: ShotQCResult = {
          shotId: decision.shotId,
          status: postStatus,
          visual: postVisual,
          audio: postAudio,
        };

        const outcome: RepairOutcome = postStatus === "FAIL" ? "STILL_FAILING" : "REPAIRED";
        return { ...base, outcome, postRepairQC };

      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        return { ...base, outcome: "ERROR", errorMessage };
      }
    })
  );

  // Tally outcomes
  const repaired = results.filter(r => r.outcome === "REPAIRED").length;
  const stillFailing = results.filter(r => r.outcome === "STILL_FAILING").length;
  const skipped = results.filter(r => r.outcome === "SKIPPED").length;
  const escalated = results.filter(r => r.outcome === "ESCALATED").length;
  const errors = results.filter(r => r.outcome === "ERROR").length;

  const status: EpisodeRepairReport["status"] =
    stillFailing > 0 || errors > 0 ? "FAILED" :
    escalated > 0 ? "NEEDS_REVIEW" :
    repaired > 0 || skipped > 0 ? "CLEAN" :
    "CLEAN";

  return {
    schemaVersion: "0.1",
    episodeId: composition.episodeId,
    repairedAt: now,
    status,
    totalRepairs: results.length,
    repaired,
    stillFailing,
    skipped,
    escalated,
    errors,
    results,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTrackByShot(
  composition: FinalCompositionSpec
): Map<string, FinalCompositionSpec["narrationDialogueTracks"][number]> {
  const map = new Map<string, FinalCompositionSpec["narrationDialogueTracks"][number]>();
  for (const shot of composition.visualComposition.shots) {
    // Find the first track whose ID contains the shotId
    const track = composition.narrationDialogueTracks.find(
      t => t.id.includes(shot.shotId) || shot.shotId.includes(t.id)
    ) ?? composition.narrationDialogueTracks[0];
    if (track) map.set(shot.shotId, track);
  }
  return map;
}

function combineStatus(
  a: "PASS" | "WARN" | "FAIL",
  b: "PASS" | "WARN" | "FAIL"
): "PASS" | "WARN" | "FAIL" {
  if (a === "FAIL" || b === "FAIL") return "FAIL";
  if (a === "WARN" || b === "WARN") return "WARN";
  return "PASS";
}

function resolvePath(assetRoot: string, relativePath: string): string {
  if (!assetRoot) return relativePath;
  const sanitized = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  return `${assetRoot.replace(/\/$/, "")}/${sanitized}`;
}
