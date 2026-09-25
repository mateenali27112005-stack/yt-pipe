/**
 * V0.9 Master Orchestrator
 *
 * Implements the Autonomous Production pipeline chaining V0.1–V0.8 modules.
 * Ensures state is persisted, checkponts are atomic, and handles QC/Repair loop.
 */

import { join } from "node:path";
import { readFile, access } from "node:fs/promises";

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
import { atomicWriteJson, hashArtifact, loadRunState, saveRunState } from "./orchestrator-state.ts";
import { createPublishingPackage } from "./approval.ts";
import type { PublishingPackage } from "./approval-types.ts";

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
  private readonly legacyStatePath: string;

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
    this.legacyStatePath = join(this.deps.workingDirectory, "production-state.json");
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
    try {
      await this.loadState(scriptMarkdown);
    } catch (err) {
      this.state.status = "FAILED";
      this.state.errors.push({ stage: this.state.currentStage, message: err instanceof Error ? err.message : String(err), timestamp: new Date().toISOString() });
      await this.saveState();
      return this.buildReviewPackage();
    }
    if (this.state.status === "COMPLETED" || this.state.status === "NEEDS_HUMAN_REVIEW") {
      return this.buildReviewPackage();
    }

    this.state.status = "RUNNING";
    this.state.inputHash = hashArtifact({ scriptMarkdown, seriesId: this.seriesId, episodeId: this.episodeId, bible: this.deps.bible });
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
        await this.commitCheckpoint("PARSED", episodeSpec, "episode-spec.json");

        // Continuity Check
        const continuityReport = checkContinuity(episodeSpec, this.deps.initialContinuityState);
        await this.writeArtifact("continuity-report.json", continuityReport);
        await this.commitCheckpoint("CONTINUITY_CHECKED", continuityReport, "continuity-report.json");
        
        if (continuityReport.status === "BLOCKED") {
          return this.haltForReview("Continuity checks failed with BLOCKING violations.");
        }

        // We combine parsed/planned since compilation is synchronous and deterministic.
        await this.commitCheckpoint("PLANNED", episodeSpec, "episode-spec.json");
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
          outputPath: join(this.deps.workingDirectory, "assets"),
          voices: { narrator: "nova", characters: characterVoices }
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
        await this.commitCheckpoint("AUDIO_GENERATED", audioManifest, "audio-manifest.json");
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
          // In a real run, we'd check if file exists and hash matches.
          assetManifest = await generateVisualAsset(visualSpec, assetManifest, asset.id, {
            provider: this.deps.imageProvider,
            seriesBible: this.deps.bible,
            outputDirectory: join(this.deps.workingDirectory, "assets")
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
        await this.commitCheckpoint("VISUALS_GENERATED", assetManifest, "asset-manifest.json");
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

        if (renderReport.status !== "OK") {
          throw new Error(`Rendering failed: ${renderReport.renderResult.reason}`);
        }
        await this.writeArtifact("render-report.json", renderReport);
        await this.commitCheckpoint("RENDERED", renderReport, "render-report.json");
      }

      // 5. QC
      let qcReport = await this.readArtifact<EpisodeQCReport>("qc-report.json");
      if (!this.hasCheckpoint("QC_CHECKED")) {
        qcReport = await runEpisodeQC(composition!, { assetRoot: this.deps.workingDirectory });
        await this.writeArtifact("qc-report.json", qcReport);
        await this.commitCheckpoint("QC_CHECKED", qcReport, "qc-report.json");
      }

      // 6. REPAIR (Loop)
      if (qcReport!.status === "FAIL" || qcReport!.status === "WARN") {
        if (!this.hasCheckpoint("REPAIRED")) {
          let currentQc = qcReport!;
          let repairCycles = 0;
          const MAX_CYCLES = 2;
          let repairedArtifactPath = "qc-report.json";

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

            // Repairers share the active manifests and composition; serialize mutations.
            let repairTail = Promise.resolve();
            const withRepairLock = async <T>(operation: () => Promise<T>): Promise<T> => {
              const previous = repairTail;
              let release!: () => void;
              repairTail = new Promise<void>(resolve => { release = resolve; });
              await previous;
              try { return await operation(); } finally { release(); }
            };

            const repairReport = await executeRepairs(decisions, {
              composition: composition!,
              assetRoot: this.deps.workingDirectory,
              visualRepairer: {
                repairVisual: (shotId) => withRepairLock(async () => {
                  const shot = composition!.visualComposition.shots.find(candidate => candidate.shotId === shotId);
                  const asset = assetManifest!.assets.find(candidate => candidate.shotId === shotId);
                  if (!shot || !asset) throw new Error(`Cannot repair visual asset for shot '${shotId}'.`);
                  assetManifest = await generateVisualAsset(visualSpec!, assetManifest!, asset.id, {
                    provider: this.deps.imageProvider,
                    seriesBible: this.deps.bible,
                    outputDirectory: join(this.deps.workingDirectory, "assets")
                  });
                  const active = assetManifest.assets.find(candidate => candidate.id === asset.id)?.versions.find(version => version.id === assetManifest!.assets.find(candidate => candidate.id === asset.id)!.activeVersionId);
                  if (!active?.output) throw new Error(`Repaired visual asset '${asset.id}' has no output.`);
                  shot.visualAsset.path = active.output.path;
                  shot.visualAsset.sha256 = active.output.sha256;
                  await this.writeArtifact("asset-manifest.json", assetManifest);
                  return { sha256: active.output.sha256, byteLength: active.output.byteLength };
                })
              },
              audioRepairer: {
                repairAudio: (shotId, audioPath, text) => withRepairLock(async () => {
                  const track = composition!.narrationDialogueTracks.find(candidate => candidate.path === audioPath || candidate.id.includes(shotId));
                  if (!track) throw new Error(`Cannot repair audio track for shot '${shotId}'.`);
                  await this.deps.speechProvider.synthesize(text, track.voice, audioPath);
                  const durationSeconds = await this.deps.speechProvider.measureDuration(audioPath);
                  track.durationSeconds = durationSeconds;
                  track.endSeconds = track.startSeconds + durationSeconds;
                  const audioAsset = audioManifest!.assets.find(asset => asset.id === track.audioAssetId);
                  if (audioAsset) audioAsset.durationSeconds = durationSeconds;
                  const segment = timeline!.segments.find(candidate => candidate.audioAssetId === track.audioAssetId);
                  if (segment) {
                    segment.durationSeconds = durationSeconds;
                    segment.endSeconds = segment.startSeconds + durationSeconds;
                  }
                  await this.writeArtifact("audio-manifest.json", audioManifest);
                  await this.writeArtifact("timeline.json", timeline);
                  return { durationSeconds };
                })
              }
            });

            await this.writeArtifact("composition.json", composition);
            const rerendered = await executeRenderPipeline({
              compositionPath: join(this.deps.workingDirectory, "composition.json"),
              audioManifestPath: join(this.deps.workingDirectory, "audio-manifest.json"),
              assetManifestPath: join(this.deps.workingDirectory, "asset-manifest.json"),
              outputPath: join(this.deps.workingDirectory, "render", "output.mp4"),
              assetRoot: this.deps.workingDirectory,
              overwrite: true,
              renderer: this.deps.renderer
            });
            if (rerendered.status !== "OK") throw new Error(`Rendering after repair failed: ${rerendered.renderResult.reason}`);
            await this.writeArtifact("render-report.json", rerendered);
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
            repairedArtifactPath = `qc-report-post-repair-${repairCycles}.json`;
            await this.writeArtifact(repairedArtifactPath, currentQc);
            
            repairCycles++;
          }

          if (currentQc.status === "FAIL") {
             throw new Error(`QC STILL FAILING after ${MAX_CYCLES} repair cycles.`);
          }

          await this.commitCheckpoint("REPAIRED", currentQc, repairedArtifactPath);
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

  private async commitCheckpoint(stage: ProductionStage, data: unknown, artifactPath?: string) {
    const dataHash = hashArtifact(data);
    this.state.checkpoints.push({
      stage,
      timestamp: new Date().toISOString(),
      dataHash,
      artifactPath
    });
    this.state.currentStage = stage;
    this.state.activeStage = undefined;
    await this.saveState();
  }

  private hasCheckpoint(stage: ProductionStage): boolean {
    return this.state.checkpoints.some(c => c.stage === stage);
  }

  private async saveState() {
    await saveRunState(this.deps.workingDirectory, this.state);
    // Preserve the original filename for existing operators and V0.9 tooling.
    await atomicWriteJson(this.legacyStatePath, this.state);
  }

  private async loadState(scriptMarkdown: string) {
    let loaded = await loadRunState(this.deps.workingDirectory);
    if (!loaded) {
      try { loaded = JSON.parse(await readFile(this.legacyStatePath, "utf8")) as ProductionRunState; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    }
    if (!loaded) return;

    const inputHash = hashArtifact({ scriptMarkdown, seriesId: this.seriesId, episodeId: this.episodeId, bible: this.deps.bible });
    if (loaded.inputHash !== inputHash) {
      // Changed source input invalidates all derived artifacts and checkpoints.
      this.state = { ...this.state, inputHash };
      return;
    }
    this.state = loaded;
    for (const checkpoint of this.state.checkpoints) {
      if (!checkpoint.artifactPath) continue;
      const artifact = await this.readArtifact<unknown>(checkpoint.artifactPath);
      if (artifact === null || hashArtifact(artifact) !== checkpoint.dataHash) {
        throw new Error(`Checkpoint integrity failure at ${checkpoint.stage}: ${checkpoint.artifactPath}`);
      }
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
    await atomicWriteJson(p, data);
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
    const videoOutputPath = join(this.deps.workingDirectory, "render", "output.mp4");
    let publishingPackage: PublishingPackage | undefined;
    if (this.state.status === "COMPLETED" && await this.fileExists(videoOutputPath)) {
      const episodeSpec = await this.readArtifact<EpisodeSpec>("episode-spec.json");
      const assetManifest = await this.readArtifact<AssetManifest>("asset-manifest.json");
      const audioManifest = await this.readArtifact<AudioAssetManifest>("audio-manifest.json");
      const rightsEvidence = [
        ...(assetManifest?.assets ?? []).map(asset => {
          const version = asset.versions.find(candidate => candidate.id === asset.activeVersionId);
          return {
            assetId: asset.id,
            provider: version?.provider?.name ?? "unknown",
            sourceReference: version?.provider?.promptHash,
            generatedAt: version?.createdAt ?? assetManifest?.generatedAt ?? new Date(0).toISOString(),
            licenseStatus: "UNKNOWN" as const,
            approvalStatus: "PENDING" as const
          };
        }),
        ...(audioManifest?.assets ?? []).map(asset => ({
          assetId: asset.id,
          provider: audioManifest.provider,
          generatedAt: audioManifest.generatedAt,
          licenseStatus: "UNKNOWN" as const,
          approvalStatus: "PENDING" as const
        }))
      ];
      publishingPackage = createPublishingPackage({
        schemaVersion: "0.1",
        packageId: `${this.runId}:${this.episodeId}`,
        episodeId: this.episodeId,
        runId: this.runId,
        videoOutputPath,
        title: episodeSpec?.episode.title ?? this.episodeId,
        description: `Episode ${episodeSpec?.episode.title ?? this.episodeId}`,
        visibility: "private",
        rightsEvidence
      });
    }
    
    return {
      schemaVersion: "0.1",
      episodeId: this.episodeId,
      runId: this.runId,
      cost: this.state.costs,
      qcReport,
      continuityReport,
      videoOutputPath: await this.fileExists(videoOutputPath) ? videoOutputPath : undefined,
      publishingPackage,
      status: this.state.status === "COMPLETED" ? "READY" : this.state.status
    };
  }

  private async fileExists(path: string): Promise<boolean> {
    try { await access(path); return true; } catch { return false; }
  }
}
