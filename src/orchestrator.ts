/**
 * V0.9 Master Orchestrator
 *
 * Implements the Autonomous Production pipeline chaining V0.1–V0.8 modules.
 * Ensures state is persisted, checkponts are atomic, and handles QC/Repair loop.
 */

import { join, dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

import type {
  ProductionRunState,
  ProductionStage,
  ProductionReviewPackage,
  ProductionCheckpoint,
  CostEntry
} from "./orchestrator-types.ts";
import type { EpisodeQCReport } from "./qc-types.ts";
import type { ContinuityCheckReport, ContinuityState } from "./continuity-types.ts";
import type { 
  EpisodeSpec, 
  SeriesBible, 
  RealizedTimeline, 
  AssetManifest, 
  ShotVisualSpec,
  FinalCompositionSpec,
  MotionCompositionPlan,
  AudioAssetManifest
} from "./types.ts";

import { parseStructuredMarkdown } from "./parser.ts";
import { compileEpisode } from "./compiler.ts";
import { checkContinuity, advanceState } from "./continuity.ts";
import { createAudioRun } from "./audio.ts";
import { createVisualPlan } from "./visual.ts";
import { generateVisualAsset } from "./image.ts"; // using generateVisualAsset + verifyAssetIntegrity
import { createMotionCompositionPlan } from "./motion.ts";
import { createFinalCompositionSpec } from "./postproduction.ts";
import { executeRenderPipeline } from "./render-pipeline.ts";
import { runEpisodeQC } from "./qc.ts";
import { decideRepairs, executeRepairs } from "./repair.ts";
import type { SpeechProvider } from "./audio.ts";
import type { ImageProvider } from "./image.ts";

export interface OrchestratorDependencies {
  speechProvider: SpeechProvider;
  imageProvider: ImageProvider;
  bible: SeriesBible;
  initialContinuityState: ContinuityState;
  workingDirectory: string;
  renderer?: any; // any to avoid circular import or needing Renderer type here for now
}

export class MasterOrchestrator {
  private state: ProductionRunState;
  private readonly statePath: string;

  private readonly runId: string;
  private readonly seriesId: string;
  private readonly episodeId: string;
  private readonly deps: OrchestratorDependencies;

  constructor(
    runId: string,
    seriesId: string,
    episodeId: string,
    deps: OrchestratorDependencies
  ) {
    this.runId = runId;
    this.seriesId = seriesId;
    this.episodeId = episodeId;
    this.deps = deps;
    this.statePath = join(this.deps.workingDirectory, "production-state.json");
    this.state = {
      schemaVersion: "0.1",
      runId,
      seriesId,
      episodeId,
      status: "STOPPED",
      currentStage: "INIT",
      checkpoints: [],
      costs: { entries: [], estimatedTotalUsd: 0 },
      errors: []
    };
  }

  /**
   * Resumes or starts a run given the script markdown.
   */
  async run(scriptMarkdown: string): Promise<ProductionReviewPackage> {
    await this.loadState();
    if (this.state.status === "COMPLETED" || this.state.status === "NEEDS_HUMAN_REVIEW") {
      return this.buildReviewPackage();
    }

    this.state.status = "RUNNING";
    await this.saveState();

    try {
      // 1. PARSE & PLAN
      let episodeSpec = await this.readArtifact<EpisodeSpec>("episode-spec.json");
      if (!this.hasCheckpoint("PLANNED")) {
        const { episode: parsed, findings: parserFindings } = parseStructuredMarkdown(scriptMarkdown);
        const { episode, report: compileReport } = compileEpisode(parsed, parserFindings, { seriesId: this.seriesId });
        episodeSpec = episode;
        await this.writeArtifact("episode-spec.json", episodeSpec);
        // Stage output is durably written. Checkpoint it.
        await this.commitCheckpoint("PARSED", episodeSpec);

        // Continuity Check
        const continuityReport = checkContinuity(episodeSpec, this.deps.initialContinuityState);
        await this.writeArtifact("continuity-report.json", continuityReport);
        await this.commitCheckpoint("CONTINUITY_CHECKED", continuityReport);
        
        if (continuityReport.status === "BLOCKED") {
          return this.haltForReview("Continuity checks failed with BLOCKING violations.");
        }

        // We combine parsed/planned since compilation is synchronous and deterministic.
        await this.commitCheckpoint("PLANNED", episodeSpec);
      }

      // 2. AUDIO GENERATION
      let audioManifest = await this.readArtifact<AudioAssetManifest>("audio-manifest.json");
      let timeline = await this.readArtifact<RealizedTimeline>("timeline.json");
      if (!this.hasCheckpoint("AUDIO_GENERATED")) {
        const characterVoices: Record<string, string> = {};
        for (const char of this.deps.bible.characters) {
          characterVoices[char.id] = "onyx";
        }
        const audioRun = await createAudioRun(episodeSpec!, {
          provider: this.deps.speechProvider,
          outputPath: join(this.deps.workingDirectory, "audio"),
          voices: { narrators: ["nova"], characterVoices }
        });
        audioManifest = audioRun.manifest;
        timeline = audioRun.timeline;
        await this.writeArtifact("audio-manifest.json", audioManifest);
        await this.writeArtifact("timeline.json", timeline);
        this.logCost({
          stage: "AUDIO_GENERATED",
          provider: this.deps.speechProvider.name,
          model: "default",
          operation: "tts_synthesis",
          estimatedUsd: 0.0, // Should be calculated based on tokens
        });
        await this.commitCheckpoint("AUDIO_GENERATED", audioManifest);
      }

      // 3. VISUAL GENERATION
      let visualSpec = await this.readArtifact<ShotVisualSpec>("visual-spec.json");
      let assetManifest = await this.readArtifact<AssetManifest>("asset-manifest.json");
      if (!this.hasCheckpoint("VISUALS_GENERATED")) {
        const plan = createVisualPlan(episodeSpec!, timeline!, {
          profile: { styleReference: "STYLE_DARK", defaultLighting: "dramatic", defaultMood: "tense", defaultCameraIntent: "cinematic" },
          seriesBible: this.deps.bible
        });
        visualSpec = plan.visualSpec;
        assetManifest = plan.manifest;

        for (const asset of assetManifest.assets) {
          if (!asset.isActive) continue;
          // In a real run, we'd check if file exists and hash matches.
          assetManifest = await generateVisualAsset(visualSpec, assetManifest, asset.id, {
            provider: this.deps.imageProvider,
            outputDirectory: join(this.deps.workingDirectory, "visuals")
          });
          this.logCost({
            stage: "VISUALS_GENERATED",
            provider: this.deps.imageProvider.name,
            model: "default",
            operation: "image_generation",
            quantity: 1,
            estimatedUsd: 0.0, // Should be calculated
          });
        }
        await this.writeArtifact("visual-spec.json", visualSpec);
        await this.writeArtifact("asset-manifest.json", assetManifest);
        await this.commitCheckpoint("VISUALS_GENERATED", assetManifest);
      }

      // 4. MOTION & POSTPRODUCTION
      let composition = await this.readArtifact<FinalCompositionSpec>("composition.json");
      if (!this.hasCheckpoint("RENDERED")) {
        const motionPlan = createMotionCompositionPlan(timeline!, visualSpec!, assetManifest!);
        composition = createFinalCompositionSpec(timeline!, audioManifest!, motionPlan, assetManifest!);
        await this.writeArtifact("composition.json", composition);

        const renderReport = await executeRenderPipeline({
          compositionPath: join(this.deps.workingDirectory, "composition.json"),
          audioManifestPath: join(this.deps.workingDirectory, "audio-manifest.json"),
          assetManifestPath: join(this.deps.workingDirectory, "asset-manifest.json"),
          outputPath: join(this.deps.workingDirectory, "render", "output.mp4"),
          assetRoot: this.deps.workingDirectory,
          overwrite: true,
          renderer: this.deps.renderer
        });

        if (renderReport.status !== "SUCCESS") {
          throw new Error(`Rendering failed: ${renderReport.errors.map(e => e.message).join(", ")}`);
        }
        await this.writeArtifact("render-report.json", renderReport);
        await this.commitCheckpoint("RENDERED", renderReport);
      }

      // 5. QC
      let qcReport = await this.readArtifact<EpisodeQCReport>("qc-report.json");
      if (!this.hasCheckpoint("QC_CHECKED")) {
        qcReport = await runEpisodeQC(composition!, { assetRoot: this.deps.workingDirectory });
        await this.writeArtifact("qc-report.json", qcReport);
        await this.commitCheckpoint("QC_CHECKED", qcReport);
      }

      // 6. REPAIR (Loop)
      if (qcReport!.status === "FAIL" || qcReport!.status === "WARN") {
        if (!this.hasCheckpoint("REPAIRED")) {
          let currentQc = qcReport!;
          let repairCycles = 0;
          const MAX_CYCLES = 2;

          while (repairCycles < MAX_CYCLES && currentQc.status !== "PASS") {
            const decisions = decideRepairs(currentQc);
            
            // Respect existing semantics: ESCALATE means human review
            const escalations = decisions.filter(d => d.action === "ESCALATE");
            if (escalations.length > 0) {
              return this.haltForReview(`QC Escalation required for ${escalations.length} shots.`);
            }

            const repairsNeeded = decisions.filter(d => d.action !== "SKIP" && d.action !== "ESCALATE");
            if (repairsNeeded.length === 0) {
              break; // Only SKIPs left, we can proceed
            }

            // Execute repairs (We'd need real repairers here, using placeholders for now)
            const repairReport = await executeRepairs(decisions, {
              composition: composition!,
              // visualRepairer: ...
              // audioRepairer: ...
            });
            await this.writeArtifact(`repair-report-${repairCycles}.json`, repairReport);

            this.logCost({
              stage: "REPAIRED",
              provider: "repair-engine",
              model: "none",
              operation: "execute_repairs",
              quantity: repairsNeeded.length,
              estimatedUsd: 0.0
            });

            // Re-run QC on the updated composition
            currentQc = await runEpisodeQC(composition!, { assetRoot: this.deps.workingDirectory });
            await this.writeArtifact(`qc-report-post-repair-${repairCycles}.json`, currentQc);
            
            repairCycles++;
          }

          if (currentQc.status === "FAIL") {
             throw new Error(`QC STILL FAILING after ${MAX_CYCLES} repair cycles.`);
          }

          await this.commitCheckpoint("REPAIRED", currentQc);
        }
      }

      // 7. COMPLETE
      this.state.status = "COMPLETED";
      this.state.currentStage = "REVIEW_READY";
      await this.saveState();
      return this.buildReviewPackage();

    } catch (err: any) {
      this.state.status = "FAILED";
      this.state.errors.push({
        stage: this.state.currentStage,
        message: err.message ?? "Unknown error",
        timestamp: new Date().toISOString()
      });
      await this.saveState();
      return this.buildReviewPackage();
    }
  }

  private haltForReview(reason: string): ProductionReviewPackage {
    this.state.status = "NEEDS_HUMAN_REVIEW";
    this.state.errors.push({
      stage: this.state.currentStage,
      message: reason,
      timestamp: new Date().toISOString()
    });
    this.saveState().catch(() => {});
    return this.buildReviewPackage();
  }

  // --- Checkpointing & State ---

  private async commitCheckpoint(stage: ProductionStage, data: any) {
    const dataHash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    this.state.checkpoints.push({
      stage,
      timestamp: new Date().toISOString(),
      dataHash
    });
    this.state.currentStage = stage;
    await this.saveState();
  }

  private hasCheckpoint(stage: ProductionStage): boolean {
    return this.state.checkpoints.some(c => c.stage === stage);
  }

  private async saveState() {
    await mkdir(dirname(this.statePath), { recursive: true });
    await writeFile(this.statePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  private async loadState() {
    try {
      const data = await readFile(this.statePath, "utf8");
      this.state = JSON.parse(data);
    } catch {
      // Ignored: state doesn't exist yet, start fresh
    }
  }

  // --- Costs ---

  private logCost(entry: Omit<CostEntry, "timestamp">) {
    this.state.costs.entries.push({
      ...entry,
      timestamp: new Date().toISOString()
    });
    this.state.costs.estimatedTotalUsd += entry.estimatedUsd;
  }

  // --- Artifacts ---

  private async writeArtifact(filename: string, data: any) {
    const p = join(this.deps.workingDirectory, filename);
    await writeFile(p, JSON.stringify(data, null, 2), "utf8");
  }

  private async readArtifact<T>(filename: string): Promise<T | null> {
    try {
      const p = join(this.deps.workingDirectory, filename);
      const data = await readFile(p, "utf8");
      return JSON.parse(data) as T;
    } catch {
      return null;
    }
  }

  private async buildReviewPackage(): Promise<ProductionReviewPackage> {
    const qcReport = await this.readArtifact<EpisodeQCReport>("qc-report.json") ?? undefined;
    const continuityReport = await this.readArtifact<ContinuityCheckReport>("continuity-report.json") ?? undefined;
    
    return {
      schemaVersion: "0.1",
      episodeId: this.episodeId,
      runId: this.runId,
      cost: this.state.costs,
      qcReport,
      continuityReport,
      status: this.state.status === "COMPLETED" ? "READY" : this.state.status
    };
  }
}
