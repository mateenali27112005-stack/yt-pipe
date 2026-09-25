import { createHash } from "node:crypto";
import type { AudioAssetManifest, FinalCompositionSpec, MotionCompositionPlan, RealizedTimeline } from "./types.ts";

export interface PostproductionOptions { compositionVersion?: number; musicStyle?: string; generatedAt?: Date; }

export function createFinalCompositionSpec(timeline: RealizedTimeline, audio: AudioAssetManifest, motion: MotionCompositionPlan, options: PostproductionOptions = {}): FinalCompositionSpec {
  assertPostproductionInputs(timeline, audio, motion);
  const compositionVersion = options.compositionVersion ?? 1;
  if (!positiveInteger(compositionVersion)) throw new Error("Composition version must be a positive integer.");
  const durationSeconds = timeline.totalDurationSeconds;
  const assets = new Map(audio.assets.map(asset => [asset.id, asset]));
  const narrationDialogueTracks = timeline.segments.map(segment => {
    const asset = assets.get(segment.audioAssetId)!;
    return { id: `MIX_${segment.id}`, audioAssetId: asset.id, path: asset.path, role: segment.role, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, gainDb: 0 };
  });
  const captions = timeline.segments.map(segment => ({ id: `CAP_${segment.id}`, role: segment.role, ...(segment.speaker ? { speaker: segment.speaker } : {}), text: segment.text, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds }));
  const musicCues = durationSeconds > 0 ? [{ id: "MUS_EPISODE_001", lifecycle: "PLANNED" as const, startSeconds: 0, endSeconds: durationSeconds, style: options.musicStyle ?? "cinematic instrumental underscore", gainDb: -18 }] : [];
  const sfxCues = motion.shots.flatMap(shot => inferSfx(shot.shotId, shot.timing.startSeconds, shot.timing.endSeconds, shot.camera.intent));
  const source = { timelineVersion: timeline.timelineVersion, audioAssets: narrationDialogueTracks, motionPlanVersion: motion.motionPlanVersion, motionManifestRevision: motion.sourceAssetManifestRevision, musicCues, sfxCues, captions };
  return { schemaVersion: "0.1", compositionVersion, episodeId: timeline.episodeId, sourceSpecVersion: timeline.sourceSpecVersion, sourceTimelineVersion: timeline.timelineVersion, sourceMotionPlanVersion: motion.motionPlanVersion, sourceAssetManifestRevision: motion.sourceAssetManifestRevision, generatedAt: (options.generatedAt ?? new Date()).toISOString(), durationSeconds, narrationDialogueTracks, musicCues, sfxCues, captions, sourceHash: hash(source) };
}

export function assertPostproductionInputs(timeline: unknown, audio: unknown, motion: unknown): asserts timeline is RealizedTimeline {
  if (!timeline || typeof timeline !== "object") throw new Error("Postproduction requires a RealizedTimeline JSON object.");
  const realized = timeline as Partial<RealizedTimeline>;
  if (realized.schemaVersion !== "0.1" || !positiveInteger(realized.timelineVersion) || !positiveInteger(realized.sourceSpecVersion) || !nonEmpty(realized.episodeId) || !finitePositive(realized.totalDurationSeconds) || !Array.isArray(realized.segments)) throw new Error("RealizedTimeline is missing required postproduction fields.");
  if (!audio || typeof audio !== "object") throw new Error("Postproduction requires an AudioAssetManifest JSON object.");
  const audioManifest = audio as Partial<AudioAssetManifest>;
  if (audioManifest.schemaVersion !== "0.1" || audioManifest.episodeId !== realized.episodeId || audioManifest.sourceSpecVersion !== realized.sourceSpecVersion || !Array.isArray(audioManifest.assets)) throw new Error("AudioAssetManifest does not match the RealizedTimeline provenance.");
  if (!motion || typeof motion !== "object") throw new Error("Postproduction requires a MotionCompositionPlan JSON object.");
  const motionPlan = motion as Partial<MotionCompositionPlan>;
  if (motionPlan.schemaVersion !== "0.1" || !positiveInteger(motionPlan.motionPlanVersion) || motionPlan.episodeId !== realized.episodeId || motionPlan.sourceSpecVersion !== realized.sourceSpecVersion || motionPlan.sourceTimelineVersion !== realized.timelineVersion || !Array.isArray(motionPlan.shots)) throw new Error("MotionCompositionPlan does not match the RealizedTimeline provenance.");
  const audioById = new Map(audioManifest.assets.map(asset => [asset.id, asset]));
  const motionShotIds = new Set(motionPlan.shots.map(shot => shot.shotId));
  for (const segment of realized.segments) {
    const asset = audioById.get(segment.audioAssetId);
    if (!segment || !asset || asset.segmentId !== segment.id || asset.shotId !== segment.shotId || asset.role !== segment.role || !validTiming(segment.startSeconds, segment.endSeconds, segment.durationSeconds)) throw new Error("RealizedTimeline contains an unresolved audio segment.");
    if (!motionShotIds.has(segment.shotId)) throw new Error(`MotionCompositionPlan does not contain shot '${segment.shotId}'.`);
  }
}

function inferSfx(shotId: string, startSeconds: number, endSeconds: number, intent: string) {
  if (/push-in/i.test(intent)) return [{ id: `SFX_${shotId}_MOTION`, lifecycle: "PLANNED" as const, shotId, startSeconds, endSeconds: Math.min(endSeconds, Number((startSeconds + 0.8).toFixed(3))), description: "subtle cinematic motion swell", gainDb: -24 }];
  return [];
}
function positiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }
function finitePositive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validTiming(start: unknown, end: unknown, duration: unknown): boolean { return [start, end, duration].every(value => typeof value === "number" && Number.isFinite(value)) && (end as number) >= (start as number) && (duration as number) === (end as number) - (start as number); }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
