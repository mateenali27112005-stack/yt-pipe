import { createHash } from "node:crypto";
import type { AudioAssetManifest, FinalCompositionSpec, MotionCompositionPlan, RealizedTimeline, AssetManifest } from "./types.ts";

export interface PostproductionOptions { compositionVersion?: number; musicStyle?: string; generatedAt?: Date; }

export function createFinalCompositionSpec(timeline: RealizedTimeline, audio: AudioAssetManifest, motion: MotionCompositionPlan, assetManifest: unknown, options: PostproductionOptions = {}): FinalCompositionSpec {
  assertPostproductionInputs(timeline, audio, motion, assetManifest);
  const compositionVersion = options.compositionVersion ?? 1;
  if (!positiveInteger(compositionVersion)) throw new Error("Composition version must be a positive integer.");
  const durationSeconds = timeline.totalDurationSeconds;
  const visualComposition = { canvas: structuredClone(motion.canvas), shots: structuredClone(motion.shots) };
  const assets = new Map(audio.assets.map(asset => [asset.id, asset]));
  const narrationDialogueTracks = timeline.segments.map(segment => {
    const asset = assets.get(segment.audioAssetId)!;
    return { id: `MIX_${segment.id}`, audioAssetId: asset.id, path: asset.path, role: segment.role, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, gainDb: 0, format: asset.format, durationSeconds: asset.durationSeconds, voice: asset.voice };
  });
  const captions = timeline.segments.map(segment => ({ id: `CAP_${segment.id}`, role: segment.role, ...(segment.speaker ? { speaker: segment.speaker } : {}), text: segment.text, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds }));
  const musicCues = durationSeconds > 0 ? [{ id: `MUS_${timeline.episodeId}`, lifecycle: "PLANNED" as const, startSeconds: 0, endSeconds: durationSeconds, style: options.musicStyle ?? "cinematic instrumental underscore", gainDb: -18 }] : [];
  const sfxCues = motion.shots.flatMap(shot => inferSfx(shot.shotId, shot.timing.startSeconds, shot.timing.endSeconds, shot.camera.intent));
  const source = { timelineVersion: timeline.timelineVersion, audioAssets: narrationDialogueTracks, visualComposition, motionPlanVersion: motion.motionPlanVersion, motionManifestRevision: motion.sourceAssetManifestRevision, musicCues, sfxCues, captions };
  return { schemaVersion: "0.1", compositionVersion, episodeId: timeline.episodeId, sourceSpecVersion: timeline.sourceSpecVersion, sourceTimelineVersion: timeline.timelineVersion, sourceMotionPlanVersion: motion.motionPlanVersion, sourceVisualSpecVersion: motion.sourceVisualSpecVersion, ...(motion.sourceSeriesBibleVersion !== undefined ? { sourceSeriesBibleVersion: motion.sourceSeriesBibleVersion } : {}), sourceAssetManifestRevision: motion.sourceAssetManifestRevision, generatedAt: (options.generatedAt ?? new Date()).toISOString(), durationSeconds, visualComposition, narrationDialogueTracks, musicCues, sfxCues, captions, sourceHash: hash(source) };
}

export function assertPostproductionInputs(timeline: unknown, audio: unknown, motion: unknown, assetManifest: unknown): asserts timeline is RealizedTimeline {
  if (!timeline || typeof timeline !== "object") throw new Error("Postproduction requires a RealizedTimeline JSON object.");
  const realized = timeline as Partial<RealizedTimeline>;
  if (!Array.isArray(realized.segments) || realized.segments.length === 0) throw new Error("Timeline must contain at least one segment.");
  if (realized.schemaVersion !== "0.1" || !positiveInteger(realized.timelineVersion) || !positiveInteger(realized.sourceSpecVersion) || !nonEmpty(realized.episodeId) || !finitePositive(realized.totalDurationSeconds) || !Array.isArray(realized.segments)) throw new Error("RealizedTimeline is missing required postproduction fields.");
  if (!audio || typeof audio !== "object") throw new Error("Postproduction requires an AudioAssetManifest JSON object.");
  const audioManifest = audio as Partial<AudioAssetManifest>;
  if (audioManifest.schemaVersion !== "0.1" || audioManifest.episodeId !== realized.episodeId || audioManifest.sourceSpecVersion !== realized.sourceSpecVersion || !Array.isArray(audioManifest.assets)) throw new Error("AudioAssetManifest does not match the RealizedTimeline provenance.");
  if (!motion || typeof motion !== "object") throw new Error("Postproduction requires a MotionCompositionPlan JSON object.");
  const motionPlan = motion as Partial<MotionCompositionPlan>;
  if (motionPlan.schemaVersion !== "0.1" || !positiveInteger(motionPlan.motionPlanVersion) || motionPlan.episodeId !== realized.episodeId || motionPlan.sourceSpecVersion !== realized.sourceSpecVersion || motionPlan.sourceTimelineVersion !== realized.timelineVersion || !Array.isArray(motionPlan.shots)) throw new Error("MotionCompositionPlan does not match the RealizedTimeline provenance.");
  
  if (!assetManifest || typeof assetManifest !== "object") throw new Error("Postproduction requires an AssetManifest JSON object.");
  const visualManifest = assetManifest as Partial<AssetManifest>;
  if (visualManifest.schemaVersion !== "0.1" || !positiveInteger(visualManifest.manifestRevision) || !Array.isArray(visualManifest.assets)) throw new Error("AssetManifest is missing required postproduction fields.");
  
  // 1. RealizedTimeline validation
  const timelineSegmentIds = new Set<string>();
  const timelineAssetIds = new Set<string>();
  let previousEnd = 0;
  for (const segment of realized.segments) {
    if (!validTiming(segment.startSeconds, segment.endSeconds, segment.durationSeconds)) throw new Error("Timeline segment has invalid timing.");
    if (segment.startSeconds < previousEnd) throw new Error("Timeline segments are overlapping or not in chronological order.");
    if (timelineSegmentIds.has(segment.id)) throw new Error("Timeline contains duplicate segment IDs.");
    if (timelineAssetIds.has(segment.audioAssetId)) throw new Error("Timeline contains duplicate audio asset IDs.");
    
    // Caption validation
    if (!nonEmpty(segment.text)) throw new Error("Timeline segment text cannot be empty.");
    if (segment.role !== "narration" && segment.role !== "dialogue") throw new Error("Timeline segment role must be narration or dialogue.");
    if (segment.role === "dialogue" && !nonEmpty(segment.speaker)) throw new Error("Timeline dialogue segment must have a speaker.");

    previousEnd = segment.endSeconds;
    timelineSegmentIds.add(segment.id);
    timelineAssetIds.add(segment.audioAssetId);
  }
  if (realized.segments.length > 0 && previousEnd !== realized.totalDurationSeconds) throw new Error("Timeline final segment endSeconds does not match totalDurationSeconds.");

  // 2. AudioAssetManifest validation
  const manifestAssetIds = new Set<string>();
  const manifestSegmentIds = new Set<string>();
  for (const asset of audioManifest.assets) {
    if (!validAudioManifestAsset(asset)) throw new Error("Audio manifest contains a malformed asset.");
    if (manifestAssetIds.has(asset.id)) throw new Error("Audio manifest contains duplicate asset IDs.");
    if (manifestSegmentIds.has(asset.segmentId)) throw new Error("Audio manifest contains duplicate segment IDs.");
    if (asset.format !== "aiff") throw new Error("Audio manifest asset format must be aiff.");
    manifestAssetIds.add(asset.id);
    manifestSegmentIds.add(asset.segmentId);
  }
  if (audioManifest.provider !== "macos-say") throw new Error("Audio manifest provider must be macos-say.");

  // AssetManifest validation
  if (!nonEmpty(visualManifest.episodeId) || !positiveInteger(visualManifest.sourceSpecVersion) || !positiveInteger(visualManifest.sourceVisualSpecVersion)) {
    throw new Error("AssetManifest provenance fields are invalid.");
  }
  if (visualManifest.episodeId !== realized.episodeId) throw new Error("AssetManifest episodeId does not match RealizedTimeline.");
  if (visualManifest.sourceSpecVersion !== realized.sourceSpecVersion) throw new Error("AssetManifest sourceSpecVersion does not match RealizedTimeline.");

  // 3. MotionCompositionPlan validation
  if (!positiveInteger(motionPlan.sourceVisualSpecVersion)) throw new Error("Motion plan sourceVisualSpecVersion must be positive integer.");
  if (visualManifest.sourceVisualSpecVersion !== motionPlan.sourceVisualSpecVersion) throw new Error("AssetManifest sourceVisualSpecVersion does not match MotionCompositionPlan.");
  if (!positiveInteger(motionPlan.sourceAssetManifestRevision)) throw new Error("Motion plan sourceAssetManifestRevision must be positive integer.");
  if (motionPlan.sourceAssetManifestRevision !== visualManifest.manifestRevision) throw new Error("MotionCompositionPlan sourceAssetManifestRevision does not match AssetManifest manifestRevision.");
  if ("sourceSeriesBibleVersion" in motionPlan && motionPlan.sourceSeriesBibleVersion !== undefined) {
    if (!positiveInteger(motionPlan.sourceSeriesBibleVersion)) throw new Error("Motion plan sourceSeriesBibleVersion must be positive integer.");
  }
  
  // 8. Motion canvas validation
  if (!motionPlan.canvas || typeof motionPlan.canvas !== "object") throw new Error("Motion plan canvas is missing or invalid.");
  if (!positiveInteger(motionPlan.canvas.width) || !positiveInteger(motionPlan.canvas.height) || !finitePositive(motionPlan.canvas.frameRate)) throw new Error("Motion plan canvas dimensions and frameRate must be valid.");

  const audioById = new Map(audioManifest.assets.map(asset => [asset.id, asset]));
  const timingByShot = new Map<string, { startSeconds: number; endSeconds: number; durationSeconds: number }>();
  for (const segment of realized.segments) {
    const current = timingByShot.get(segment.shotId);
    const startSeconds = current ? Math.min(current.startSeconds, segment.startSeconds) : segment.startSeconds;
    const endSeconds = current ? Math.max(current.endSeconds, segment.endSeconds) : segment.endSeconds;
    timingByShot.set(segment.shotId, { startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds });
  }
  const visualManifestAssets = new Map<string, any>();
  for (const asset of visualManifest.assets!) {
    if (!validVisualManifestAsset(asset)) throw new Error("AssetManifest contains a malformed asset.");
    if (visualManifestAssets.has(asset.id)) throw new Error(`AssetManifest contains duplicate asset ID '${asset.id}'.`);
    visualManifestAssets.set(asset.id, asset);
  }
  const motionShotIds = new Set<string>();
  const motionShotRecordIds = new Set<string>();
  let previousStart = -1;
  for (const shot of motionPlan.shots) {
    if (!validMotionShot(shot)) throw new Error("MotionCompositionPlan contains an invalid visual composition shot.");
    if (motionShotRecordIds.has(shot.id)) throw new Error(`MotionCompositionPlan contains duplicate record '${shot.id}'.`);
    if (motionShotIds.has(shot.shotId)) throw new Error(`MotionCompositionPlan contains duplicate shot '${shot.shotId}'.`);
    motionShotRecordIds.add(shot.id);
    const manifestAsset = visualManifestAssets.get(shot.visualAsset.assetId);
    const activeReference = manifestAsset ? resolveActiveVisualReference(manifestAsset) : undefined;
    if (!manifestAsset || !activeReference || activeReference.versionId !== shot.visualAsset.assetVersionId || activeReference.path !== shot.visualAsset.path || activeReference.sha256 !== shot.visualAsset.sha256) {
      throw new Error(`MotionCompositionPlan shot '${shot.shotId}' provenance does not match AssetManifest active version.`);
    }
    const timelineTiming = timingByShot.get(shot.shotId);
    if (!timelineTiming || !sameTiming(shot.timing, timelineTiming)) throw new Error(`MotionCompositionPlan shot '${shot.shotId}' does not match the RealizedTimeline timing.`);
    if (shot.timing.startSeconds < previousStart) throw new Error("MotionCompositionPlan shots are not in realized timeline order.");
    previousStart = shot.timing.startSeconds;
    motionShotIds.add(shot.shotId);
  }
  for (const segment of realized.segments) {
    const asset = audioById.get(segment.audioAssetId);
    if (!segment || !nonEmpty(segment.id) || !nonEmpty(segment.audioAssetId) || !nonEmpty(segment.shotId)) throw new Error("RealizedTimeline contains a malformed segment ID.");
    if (!validAudioAsset(asset, segment) || !validTiming(segment.startSeconds, segment.endSeconds, segment.durationSeconds)) throw new Error("RealizedTimeline contains an unresolved audio segment.");
    if (Math.abs(asset!.durationSeconds - segment.durationSeconds) >= 0.0001) throw new Error("Audio asset duration must match timeline segment duration.");
    if (!motionShotIds.has(segment.shotId)) throw new Error(`MotionCompositionPlan does not contain shot '${segment.shotId}'.`);
  }
  if (timingByShot.size !== motionShotIds.size) throw new Error("MotionCompositionPlan shots do not exactly match RealizedTimeline shots.");
}

function validMotionShot(shot: unknown): shot is MotionCompositionPlan["shots"][number] {
  if (!shot || typeof shot !== "object") return false;
  const candidate = shot as MotionCompositionPlan["shots"][number];
  if (!nonEmpty(candidate.id) || !nonEmpty(candidate.sceneId) || !nonEmpty(candidate.shotId) || !nonEmpty(candidate.sourceHash) || !/^[a-f0-9]{64}$/.test(candidate.sourceHash)) return false;
  if (!candidate.visualAsset || ![candidate.visualAsset.assetId, candidate.visualAsset.assetVersionId, candidate.visualAsset.path].every(nonEmpty) || !/^[a-f0-9]{64}$/.test(candidate.visualAsset.sha256)) return false;
  if (!validTiming(candidate.timing?.startSeconds, candidate.timing?.endSeconds, candidate.timing?.durationSeconds)) return false;
  if (!candidate.camera || !nonEmpty(candidate.camera.intent) || !Array.isArray(candidate.camera.keyframes) || candidate.camera.keyframes.length !== 2) return false;
  if (!candidate.camera.keyframes.every((keyframe, index) => keyframe && keyframe.offset === index && finitePositive(keyframe.scale) && finiteUnit(keyframe.x) && finiteUnit(keyframe.y))) return false;
  const transition = candidate.transitionIn;
  return !transition || (transition.atSeconds === candidate.timing.startSeconds && ((transition.type === "CUT" && transition.durationSeconds === 0) || (transition.type === "CROSSFADE" && finitePositive(transition.durationSeconds) && transition.durationSeconds <= Math.min(0.35, candidate.timing.durationSeconds / 4))));
}

function validAudioManifestAsset(asset: unknown): boolean {
  if (!asset || typeof asset !== "object") return false;
  const a = asset as Record<string, any>;
  return typeof a.id === "string" && a.id.length > 0 &&
         typeof a.segmentId === "string" && a.segmentId.length > 0 &&
         typeof a.shotId === "string" && a.shotId.length > 0 &&
         (a.role === "narration" || a.role === "dialogue") &&
         typeof a.voice === "string" && a.voice.length > 0 &&
         typeof a.path === "string" && a.path.length > 0 &&
         typeof a.format === "string" && a.format.length > 0 &&
         typeof a.durationSeconds === "number" && Number.isFinite(a.durationSeconds) && a.durationSeconds > 0;
}

function validAudioAsset(asset: AudioAssetManifest["assets"][number] | undefined, segment: RealizedTimeline["segments"][number]): boolean {
  return Boolean(asset && nonEmpty(asset.id) && asset.segmentId === segment.id && asset.shotId === segment.shotId && asset.role === segment.role && nonEmpty(asset.voice) && nonEmpty(asset.path) && nonEmpty(asset.format) && finitePositive(asset.durationSeconds));
}

function inferSfx(shotId: string, startSeconds: number, endSeconds: number, intent: string) {
  if (/push-in/i.test(intent)) return [{ id: `SFX_${shotId}_MOTION`, lifecycle: "PLANNED" as const, shotId, startSeconds, endSeconds: Math.min(endSeconds, Number((startSeconds + 0.8).toFixed(3))), description: "subtle cinematic motion swell", gainDb: -24 }];
  return [];
}
function positiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }
function finitePositive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validTiming(start: unknown, end: unknown, duration: unknown): boolean { return [start, end, duration].every(value => typeof value === "number" && Number.isFinite(value)) && (start as number) >= 0 && (end as number) > (start as number) && Math.abs((duration as number) - ((end as number) - (start as number))) < 0.0001; }
function sameTiming(left: { startSeconds: number; endSeconds: number; durationSeconds: number }, right: { startSeconds: number; endSeconds: number; durationSeconds: number }): boolean { return left.startSeconds === right.startSeconds && left.endSeconds === right.endSeconds && left.durationSeconds === right.durationSeconds; }
function finiteUnit(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function validVisualManifestAsset(asset: unknown): boolean {
  if (!asset || typeof asset !== "object") return false;
  const a = asset as Record<string, any>;
  const active = resolveActiveVisualReference(a);
  return nonEmpty(a.id) && nonEmpty(a.shotId) && Boolean(active) &&
         nonEmpty(active?.versionId) && nonEmpty(active?.path) &&
         nonEmpty(active?.sha256) && /^[a-f0-9]{64}$/.test(active?.sha256 ?? "");
}

function resolveActiveVisualReference(asset: Record<string, any>): { versionId: string; path: string; sha256: string } | undefined {
  if (asset.activeReferenceAsset && typeof asset.activeReferenceAsset === "object") return asset.activeReferenceAsset;
  const active = Array.isArray(asset.versions) ? asset.versions.find((version: any) => version.id === asset.activeVersionId) : undefined;
  if (active?.lifecycle !== "GENERATED" || !active.output) return undefined;
  return { versionId: active.id, path: active.output.path, sha256: active.output.sha256 };
}
