import type { EpisodeSpec, FinalCompositionSpec, RealizedTimeline } from "./types.ts";

export type ProductionStage = "INIT" | "PARSED" | "CONTINUITY_CHECKED" | "PLANNED" | "AUDIO_GENERATED" | "VISUALS_GENERATED" | "RENDERED" | "QC_CHECKED" | "REPAIRED" | "COMPLETED" | "FAILED";
export type RunStatus = "IDLE" | "RUNNING" | "COMPLETED" | "FAILED" | "NEEDS_HUMAN_REVIEW";

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

export interface CostLedger { entries: CostEntry[]; estimatedTotalUsd: number; }

export interface ProductionCheckpoint {
  stage: ProductionStage;
  timestamp: string;
  dataHash: string;
  artifactPath: string;
}

export interface ProductionRunState {
  schemaVersion: "0.9";
  runId: string;
  seriesId: string;
  episodeId: string;
  inputHash: string;
  currentStage: ProductionStage;
  activeStage?: ProductionStage;
  status: RunStatus;
  checkpoints: ProductionCheckpoint[];
  artifacts: Partial<Record<ProductionStage, string>>;
  costs: CostLedger;
  errors: Array<{ stage: ProductionStage; message: string; timestamp: string }>;
}

export interface ContinuityCheckReport { status: "PASS" | "WARN" | "BLOCKING"; findings: Array<{ code: string; message: string; severity: "INFO" | "WARN" | "BLOCKING" }>; }
export interface EpisodeQCReport { status: "PASS" | "WARN" | "FAIL"; findings: Array<{ code: string; message: string; severity: "INFO" | "WARN" | "FAIL" }>; }
export interface EpisodeRepairReport { status: "REPAIRED" | "UNCHANGED" | "FAILED"; actions: string[]; }
export type RepairDecision = "SKIP" | "RETRY" | "ESCALATE";

export interface ProductionReviewPackage {
  episodeId: string;
  runId: string;
  durationSeconds: number;
  cost: CostLedger;
  qcReport: EpisodeQCReport;
  repairReport?: EpisodeRepairReport;
  continuityReport: ContinuityCheckReport;
  videoOutputPath: string;
  status: "READY" | "NEEDS_HUMAN_REVIEW" | "FAILED";
  capabilityGaps?: string[];
}

export interface StageOutput<T = unknown> {
  data: T;
  artifactName?: string;
  durationSeconds?: number;
  videoOutputPath?: string;
  costs?: CostEntry[];
}

export interface ProductionInput { scriptPath?: string; scriptText?: string; seriesId: string; episodeId: string; }
export interface StageContext {
  input: ProductionInput;
  runDirectory: string;
  state: ProductionRunState;
  artifacts: Partial<Record<ProductionStage, unknown>>;
}

export interface ProductionAdapters {
  parse(context: StageContext): Promise<StageOutput>;
  continuity(context: StageContext): Promise<StageOutput<ContinuityCheckReport>>;
  plan(context: StageContext): Promise<StageOutput>;
  audio(context: StageContext): Promise<StageOutput<{ manifest: unknown; timeline: RealizedTimeline }>>;
  visuals(context: StageContext): Promise<StageOutput>;
  render(context: StageContext): Promise<StageOutput<{ composition: FinalCompositionSpec }>>;
  qc(context: StageContext): Promise<StageOutput<EpisodeQCReport>>;
  decideRepairs(context: StageContext, report: EpisodeQCReport): Promise<RepairDecision>;
  repair(context: StageContext): Promise<StageOutput<EpisodeRepairReport>>;
}

export interface OrchestratorOptions { maxRepairCycles?: number; now?: () => Date; adapters: ProductionAdapters; }
