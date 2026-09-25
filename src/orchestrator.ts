import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileEpisode } from "./compiler.ts";
import { parseStructuredMarkdown } from "./parser.ts";
import { createAudioRun } from "./audio.ts";
import { createVisualPlan } from "./visual.ts";
import { createMotionCompositionPlan } from "./motion.ts";
import { createFinalCompositionSpec } from "./postproduction.ts";
import { generateAndPublishVisualAsset } from "./image.ts";
import { getImageProvider } from "./image-providers.ts";
import { atomicWriteJson, hashArtifact, loadRunState, readArtifact, saveRunState } from "./orchestrator-state.ts";
import type { AssetManifest, EpisodeSpec, FinalCompositionSpec, RealizedTimeline, SeriesBible, VisualProfile } from "./types.ts";
import type { ContinuityCheckReport, CostEntry, EpisodeQCReport, EpisodeRepairReport, ProductionAdapters, ProductionInput, ProductionReviewPackage, ProductionRunState, ProductionStage, RepairDecision, StageContext, StageOutput, OrchestratorOptions } from "./orchestrator-types.ts";

const stages: ProductionStage[] = ["PARSED", "CONTINUITY_CHECKED", "PLANNED", "AUDIO_GENERATED", "VISUALS_GENERATED", "RENDERED"];
const prior: ProductionStage[] = ["INIT", ...stages];

export class ProductionOrchestrator {
  private readonly maxRepairCycles: number;
  private readonly now: () => Date;
  private readonly options: OrchestratorOptions;
  constructor(options: OrchestratorOptions) { this.options = options; this.maxRepairCycles = options.maxRepairCycles ?? 2; this.now = options.now ?? (() => new Date()); }

  async run(input: ProductionInput, runDirectory: string): Promise<ProductionReviewPackage> {
    this.runDirectory = runDirectory;
    const script = input.scriptText ?? await readFile(resolve(input.scriptPath ?? ""), "utf8");
    const inputHash = hashArtifact({ script, seriesId: input.seriesId, episodeId: input.episodeId });
    let state = await loadRunState(runDirectory);
    if (!state || state.inputHash !== inputHash) state = this.newState(input, inputHash);
    state.status = "RUNNING";
    await saveRunState(runDirectory, state);
    const artifacts: Partial<Record<ProductionStage, unknown>> = {};
    for (const checkpoint of state.checkpoints) {
      const artifact = await readArtifact(runDirectory, checkpoint.artifactPath);
      if (hashArtifact(artifact) !== checkpoint.dataHash) throw new Error(`Checkpoint integrity failure for ${checkpoint.stage}.`);
      artifacts[checkpoint.stage] = artifact;
    }
    const context = (): StageContext => ({ input, runDirectory, state: state!, artifacts });
    try {
      let start = state.activeStage ? stages.indexOf(state.activeStage) : Math.max(0, stages.indexOf(nextStage(state.currentStage)));
      if (state.currentStage === "COMPLETED") return (artifacts.COMPLETED as ProductionReviewPackage) ?? this.reviewFrom(artifacts, state, "READY");
      if (start < 0) start = 0;
      for (let index = start; index < stages.length; index += 1) {
        const stage = stages[index];
        if (stage === "CONTINUITY_CHECKED" && !artifacts.PARSED) throw new Error("Cannot run continuity before parsing.");
        const output = await this.executeStage(stage, context(), this.adapter(stage));
        artifacts[stage] = output.data;
        if (stage === "CONTINUITY_CHECKED" && (output.data as ContinuityCheckReport).status === "BLOCKING") {
          state.status = "FAILED";
          this.recordError(state, stage, "Blocking continuity violation.");
          await saveRunState(runDirectory, state);
          return this.reviewFrom(artifacts, state, "FAILED");
        }
      }
      const qcResult = await this.runQcLoop(context(), artifacts);
      if (qcResult !== "PASS" && qcResult !== "SKIP") {
        state.status = qcResult === "ESCALATE" ? "NEEDS_HUMAN_REVIEW" : "FAILED";
        return this.reviewFrom(artifacts, state, state.status === "NEEDS_HUMAN_REVIEW" ? "NEEDS_HUMAN_REVIEW" : "FAILED");
      }
      const review = this.reviewFrom(artifacts, state, "READY");
      await this.commit("COMPLETED", review, state, artifacts);
      state.status = "COMPLETED";
      await saveRunState(runDirectory, state);
      return review;
    } catch (cause) {
      const stage = state.activeStage ?? nextStage(state.currentStage);
      state.status = "FAILED";
      this.recordError(state, stage, cause instanceof Error ? cause.message : String(cause));
      await saveRunState(runDirectory, state);
      throw cause;
    }
  }

  private adapter(stage: ProductionStage): (context: StageContext) => Promise<StageOutput> {
    const map: Record<string, (context: StageContext) => Promise<StageOutput>> = { PARSED: this.options.adapters.parse, CONTINUITY_CHECKED: this.options.adapters.continuity, PLANNED: this.options.adapters.plan, AUDIO_GENERATED: this.options.adapters.audio, VISUALS_GENERATED: this.options.adapters.visuals, RENDERED: this.options.adapters.render };
    return map[stage].bind(this.options.adapters);
  }

  private async executeStage(stage: ProductionStage, context: StageContext, adapter: (context: StageContext) => Promise<StageOutput>): Promise<StageOutput> {
    context.state.activeStage = stage;
    await saveRunState(context.runDirectory, context.state);
    const output = await adapter(context);
    if (!output || output.data === undefined) throw new Error(`${stage} did not return a durable artifact.`);
    await this.commit(stage, output.data, context.state, context.artifacts, output);
    return output;
  }

  private async commit(stage: ProductionStage, data: unknown, state: ProductionRunState, artifacts: Partial<Record<ProductionStage, unknown>>, output?: StageOutput): Promise<void> {
    const artifactPath = `artifacts/${stage}.json`;
    await atomicWriteJson(resolve(this.runDirectoryFor(state), artifactPath), data);
    const checkpoint = { stage, timestamp: this.now().toISOString(), dataHash: hashArtifact(data), artifactPath };
    state.checkpoints = [...state.checkpoints.filter(item => item.stage !== stage), checkpoint];
    state.artifacts[stage] = artifactPath;
    state.currentStage = stage;
    state.activeStage = undefined;
    for (const entry of output?.costs ?? []) { state.costs.entries.push(entry); state.costs.estimatedTotalUsd += entry.estimatedUsd; }
    artifacts[stage] = data;
    await saveRunState(this.runDirectoryFor(state), state);
  }

  private runDirectoryFor(state: ProductionRunState): string { return (state as ProductionRunState & { __runDirectory?: string }).__runDirectory ?? this.runDirectory; }
  private runDirectory = "";

  private async runQcLoop(context: StageContext, artifacts: Partial<Record<ProductionStage, unknown>>): Promise<"PASS" | "SKIP" | "ESCALATE" | "FAILED"> {
    const state = context.state;
    let cycles = state.costs.entries.filter(entry => entry.operation === "repair").length;
    while (true) {
      const qc = await this.executeStage("QC_CHECKED", context, this.options.adapters.qc);
      artifacts.QC_CHECKED = qc.data;
      const report = qc.data as EpisodeQCReport;
      if (report.status === "PASS") return "PASS";
      const decision = await this.options.adapters.decideRepairs(context, report);
      if (decision === "SKIP") return "SKIP";
      if (decision === "ESCALATE") return "ESCALATE";
      if (cycles >= this.maxRepairCycles) return "FAILED";
      const repair = await this.executeStage("REPAIRED", context, this.options.adapters.repair);
      artifacts.REPAIRED = repair.data;
      cycles += 1;
    }
  }

  private reviewFrom(artifacts: Partial<Record<ProductionStage, unknown>>, state: ProductionRunState, status: ProductionReviewPackage["status"] = state.status === "NEEDS_HUMAN_REVIEW" ? "NEEDS_HUMAN_REVIEW" : "FAILED"): ProductionReviewPackage {
    const continuity = (artifacts.CONTINUITY_CHECKED as ContinuityCheckReport | undefined) ?? { status: "PASS", findings: [] };
    const qc = (artifacts.QC_CHECKED as EpisodeQCReport | undefined) ?? { status: "FAIL", findings: [{ code: "QC_UNAVAILABLE", message: "Quality control did not complete.", severity: "FAIL" as const }] };
    const repair = artifacts.REPAIRED as EpisodeRepairReport | undefined;
    const render = artifacts.RENDERED as { composition?: FinalCompositionSpec; videoOutputPath?: string } | undefined;
    return { episodeId: state.episodeId, runId: state.runId, durationSeconds: render?.composition?.durationSeconds ?? 0, cost: state.costs, qcReport: qc, ...(repair ? { repairReport: repair } : {}), continuityReport: continuity, videoOutputPath: render?.videoOutputPath ?? "", status, capabilityGaps: ["Repository has no renderer, QC, or repair implementation yet; those must be supplied through adapters."] };
  }

  private newState(input: ProductionInput, inputHash: string): ProductionRunState & { __runDirectory?: string } { return { schemaVersion: "0.9", runId: `${input.episodeId}-${Date.now()}`, seriesId: input.seriesId, episodeId: input.episodeId, inputHash, currentStage: "INIT", status: "IDLE", checkpoints: [], artifacts: {}, costs: { entries: [], estimatedTotalUsd: 0 }, errors: [] }; }
  private recordError(state: ProductionRunState, stage: ProductionStage, message: string): void { state.errors.push({ stage, message, timestamp: this.now().toISOString() }); }
}

function nextStage(stage: ProductionStage): ProductionStage { const index = prior.indexOf(stage); return stages[Math.min(Math.max(index, 0), stages.length - 1)]; }

export function createDefaultAdapters(config: { seriesId: string; visualProfile: VisualProfile; voices: import("./types.ts").AudioVoiceRegistry; provider?: "fake" | "openai"; seriesBible?: SeriesBible }): ProductionAdapters {
  return {
    async parse(context) { const text = context.input.scriptText ?? await readFile(resolve(context.input.scriptPath ?? ""), "utf8"); const parsed = parseStructuredMarkdown(text); const compiled = compileEpisode(parsed.episode, parsed.findings, { seriesId: context.input.seriesId, episodeId: context.input.episodeId }); return { data: compiled }; },
    async continuity(context) { const parsed = context.artifacts.PARSED as { report: { findings: Array<{ code: string; message: string; severity: string }> } }; const blocking = parsed.report.findings.filter(f => f.severity === "error"); return { data: { status: blocking.length ? "BLOCKING" : "PASS", findings: blocking.map(f => ({ code: f.code, message: f.message, severity: "BLOCKING" as const })) } satisfies ContinuityCheckReport }; },
    async plan(context) { return { data: context.artifacts.PARSED }; },
    async audio(context) { const spec = (context.artifacts.PARSED as { episode: EpisodeSpec }).episode; return { data: await createAudioRun(spec, { outputPath: resolve(context.runDirectory, "audio/assets"), voices: config.voices }) }; },
    async visuals(context) { const parsed = context.artifacts.PARSED as { episode: EpisodeSpec }; const audio = context.artifacts.AUDIO_GENERATED as { timeline: RealizedTimeline }; const planned = createVisualPlan(parsed.episode, audio.timeline, { profile: config.visualProfile, seriesBible: config.seriesBible }); let manifest = planned.manifest; const visualDirectory = resolve(context.runDirectory, "visual/assets"); for (const asset of manifest.assets) manifest = await generateAndPublishVisualAsset(planned.visualSpec, manifest, asset.id, { outputDirectory: visualDirectory, manifestPath: resolve(context.runDirectory, "visual/asset_manifest.json"), provider: getImageProvider(config.provider ?? "fake"), seriesBible: config.seriesBible, publishManifest: async next => { await atomicWriteJson(resolve(context.runDirectory, "visual/asset_manifest.json"), next); } }); return { data: { visualSpec: planned.visualSpec, manifest } }; },
    async render() { throw new Error("Renderer is not implemented in this V0.7 repository; provide a render adapter for a genuine video output."); },
    async qc() { throw new Error("QC is not implemented in this V0.7 repository; provide a QC adapter."); },
    async decideRepairs() { return "ESCALATE" as RepairDecision; },
    async repair() { return { data: { status: "FAILED", actions: [] } satisfies EpisodeRepairReport }; }
  };
}
