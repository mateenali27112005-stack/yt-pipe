/**
 * V0.9 Master Orchestrator — Domain Types
 *
 * Defines the state, checkpointing, cost ledger, and review package for the
 * Autonomous Production pipeline.
 */

import type { EpisodeQCReport, EpisodeRepairReport } from "./qc-types.ts";
import type { ContinuityCheckReport } from "./continuity-types.ts";

export type ProductionStage =
  | "INIT"
  | "PARSED"             // Script parsed into intermediate structure
  | "CONTINUITY_CHECKED" // Continuity verified (no blocking violations)
  | "PLANNED"            // FinalCompositionSpec established
  | "AUDIO_GENERATED"    // All audio assets generated and validated
  | "VISUALS_GENERATED"  // All visual assets generated and validated
  | "RENDERED"           // Final video file produced
  | "QC_CHECKED"         // runEpisodeQC complete
  | "REPAIRED"           // Repair loop complete
  | "REVIEW_READY";      // Ready for human review

export interface ProductionCheckpoint {
  stage: ProductionStage;
  timestamp: string;
  /**
   * Deterministic hash of the stage's persisted artifact.
   * e.g.,
   * PARSED -> hash(episode-spec.json)
   * PLANNED -> hash(final-composition-spec.json)
   * AUDIO_GENERATED -> hash(audio-manifest.json)
   * VISUALS_GENERATED -> hash(asset-manifest.json)
   * RENDERED -> hash(rendered media file or its metadata)
   * QC_CHECKED -> hash(qc-report.json)
   * REPAIRED -> hash(repair-report.json)
   */
  dataHash: string;
}

export interface CostEntry {
  timestamp: string;
  stage: ProductionStage;
  provider: string;
  model: string;
  operation: string;
  quantity?: number;
  estimatedUsd: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface CostLedger {
  entries: CostEntry[];
  estimatedTotalUsd: number;
}

export interface ProductionRunState {
  schemaVersion: "0.1";
  runId: string;
  seriesId: string;
  episodeId: string;
  /**
   * Status differentiates between automated failure and requiring human input.
   * RUNNING: Currently executing.
   * STOPPED: Halted cleanly (e.g. at a checkpoint).
   * NEEDS_HUMAN_REVIEW: Stopped deliberately for human input (e.g., ESCALATE).
   * FAILED: Process couldn't complete the operation (e.g. unrecoverable API error, missing file).
   * COMPLETED: Reached the end of the pipeline.
   */
  status: "RUNNING" | "STOPPED" | "NEEDS_HUMAN_REVIEW" | "FAILED" | "COMPLETED";
  currentStage: ProductionStage;
  checkpoints: ProductionCheckpoint[];
  costs: CostLedger;
  errors: Array<{
    stage: ProductionStage;
    message: string;
    timestamp: string;
  }>;
}

export interface ProductionReviewPackage {
  schemaVersion: "0.1";
  episodeId: string;
  runId: string;
  durationSeconds?: number;
  cost: CostLedger;
  qcReport?: EpisodeQCReport;
  repairReport?: EpisodeRepairReport;
  continuityReport?: ContinuityCheckReport;
  videoOutputPath?: string;
  status: "READY" | "NEEDS_HUMAN_REVIEW" | "FAILED";
}
