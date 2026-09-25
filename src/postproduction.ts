import { createHash } from "node:crypto";
import type { AudioAssetManifest, FinalCompositionSpec, MotionCompositionPlan, RealizedTimeline } from "./types.ts";

export interface PostproductionOptions { compositionVersion?: number; musicStyle?: string; generatedAt?: Date; }

export function createFinalCompositionSpec(timeline: RealizedTimeline, audio: AudioAssetManifest, motion: MotionCompositionPlan, options: PostproductionOptions = {}): FinalCompositionSpec {
  assertPostproductionInputs(timeline, audio, motion);
  const compositionVersion = options.compositionVersion ?? 1;
  if (!positiveInteger(compositionVersion)) throw new Error("Composition version must be a positive integer.");
  const durationSeconds = timeline.totalDurationSeconds;
  const visualComposition = { canvas: structuredClone(motion.canvas), shots: structuredClone(motion.shots) };
  const assets = new Map(audio.assets.map(asset => [asset.id, asset]));
  const narrationDialogueTracks = timeline.segments.map(segment => {
    const asset = assets.get(segment.audioAssetId)!;
    return { id: `MIX_${segment.id}`, audioAssetId: asset.id, path: asset.path, format: asset.format, durationSeconds: asset.durationSeconds, sha256: asset.sha256, voice: asset.voice, role: segment.role, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds, gainDb: 0 };
  });
  const captions = timeline.segments.map(segment => ({ id: `CAP_${segment.id}`, role: segment.role, ...(segment.speaker ? { speaker: segment.speaker } : {}), text: segment.text, startSeconds: segment.startSeconds, endSeconds: segment.endSeconds }));
  const musicCues = durationSeconds > 0 ? [{ id: `MUS_${timeline.episodeId}`, lifecycle: "PLANNED" as const, startSeconds: 0, endSeconds: durationSeconds, style: options.musicStyle ?? "cinematic instrumental underscore", gainDb: -18 }] : [];
  const sfxCues = motion.shots.flatMap(shot => inferSfx(shot.shotId, shot.timing.startSeconds, shot.timing.endSeconds, shot.camera.intent));
  const source = { timelineVersion: timeline.timelineVersion, audioAssets: narrationDialogueTracks, visualComposition, motionPlanVersion: motion.motionPlanVersion, motionManifestRevision: motion.sourceAssetManifestRevision, musicCues, sfxCues, captions };
  return { schemaVersion: "0.1", compositionVersion, episodeId: timeline.episodeId, sourceSpecVersion: timeline.sourceSpecVersion, sourceTimelineVersion: timeline.timelineVersion, sourceMotionPlanVersion: motion.motionPlanVersion, sourceAssetManifestRevision: motion.sourceAssetManifestRevision, generatedAt: (options.generatedAt ?? new Date()).toISOString(), durationSeconds, visualComposition, narrationDialogueTracks, musicCues, sfxCues, captions, sourceHash: hash(source) };
}

export function assertPostproductionInputs(timeline: unknown, audio: unknown, motion: unknown): asserts timeline is RealizedTimeline {
  if (!timeline || typeof timeline !== "object") throw new Error("Postproduction requires a RealizedTimeline JSON object.");
  const realized = timeline as Partial<RealizedTimeline>;
  if (realized.schemaVersion !== "0.1" || !positiveInteger(realized.timelineVersion) || !positiveInteger(realized.sourceSpecVersion) || !nonEmpty(realized.episodeId) || !finitePositive(realized.totalDurationSeconds) || !Array.isArray(realized.segments)) throw new Error("RealizedTimeline is missing required postproduction fields.");
  if (!audio || typeof audio !== "object") throw new Error("Postproduction requires an AudioAssetManifest JSON object.");
  const audioManifest = audio as Partial<AudioAssetManifest>;
  if (audioManifest.schemaVersion !== "0.1" || audioManifest.provider !== "macos-say" || audioManifest.episodeId !== realized.episodeId || audioManifest.sourceSpecVersion !== realized.sourceSpecVersion || !Array.isArray(audioManifest.assets)) throw new Error("AudioAssetManifest does not match the RealizedTimeline provenance.");
  if (!motion || typeof motion !== "object") throw new Error("Postproduction requires a MotionCompositionPlan JSON object.");
  const motionPlan = motion as Partial<MotionCompositionPlan>;
  if (motionPlan.schemaVersion !== "0.1" || !positiveInteger(motionPlan.motionPlanVersion) || !positiveInteger(motionPlan.sourceVisualSpecVersion) || !positiveInteger(motionPlan.sourceAssetManifestRevision) || (motionPlan.sourceSeriesBibleVersion !== undefined && !positiveInteger(motionPlan.sourceSeriesBibleVersion)) || motionPlan.episodeId !== realized.episodeId || motionPlan.sourceSpecVersion !== realized.sourceSpecVersion || motionPlan.sourceTimelineVersion !== realized.timelineVersion || !Array.isArray(motionPlan.shots)) throw new Error("MotionCompositionPlan does not match the RealizedTimeline provenance.");
  const segmentIds = new Set<string>();
  const audioAssetIds = new Set<string>();
  let previousEnd = 0;
  for (const segment of realized.segments) {
    if (!segment || !nonEmpty(segment.id) || !nonEmpty(segment.audioAssetId) || !nonEmpty(segment.shotId) || !nonEmpty(segment.text) || !["narration", "dialogue"].includes(segment.role) || (segment.role === "dialogue" && !nonEmpty(segment.speaker)) || !validTiming(segment.startSeconds, segment.endSeconds, segment.durationSeconds) || segment.startSeconds !== previousEnd || segmentIds.has(segment.id) || audioAssetIds.has(segment.audioAssetId)) throw new Error("RealizedTimeline contains invalid chronological segments.");
    segmentIds.add(segment.id);
    audioAssetIds.add(segment.audioAssetId);
    previousEnd = segment.endSeconds;
  }
  if (previousEnd !== realized.totalDurationSeconds) throw new Error("RealizedTimeline totalDurationSeconds does not match its final segment.");
  const manifestAssetIds = new Set<string>();
  const manifestSegmentIds = new Set<string>();
  for (const asset of audioManifest.assets) {
    if (!asset || !nonEmpty(asset.id) || !nonEmpty(asset.segmentId) || manifestAssetIds.has(asset.id) || manifestSegmentIds.has(asset.segmentId)) throw new Error("AudioAssetManifest contains duplicate or invalid asset identities.");
    manifestAssetIds.add(asset.id);
    manifestSegmentIds.add(asset.segmentId);
  }
  const audioById = new Map(audioManifest.assets.map(asset => [asset.id, asset]));
  const timingByShot = new Map<string, { startSeconds: number; endSeconds: number; durationSeconds: number }>();
  for (const segment of realized.segments) {
    const current = timingByShot.get(segment.shotId);
    const startSeconds = current ? Math.min(current.startSeconds, segment.startSeconds) : segment.startSeconds;
    const endSeconds = current ? Math.max(current.endSeconds, segment.endSeconds) : segment.endSeconds;
    timingByShot.set(segment.shotId, { startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds });
  }
  const motionShotIds = new Set<string>();
  let previousStart = -1;
  for (const shot of motionPlan.shots) {
    if (!validMotionShot(shot)) throw new Error("MotionCompositionPlan contains an invalid visual composition shot.");
    if (motionShotIds.has(shot.shotId)) throw new Error(`MotionCompositionPlan contains duplicate shot '${shot.shotId}'.`);
    const timelineTiming = timingByShot.get(shot.shotId);
    if (!timelineTiming || !sameTiming(shot.timing, timelineTiming)) throw new Error(`MotionCompositionPlan shot '${shot.shotId}' does not match the RealizedTimeline timing.`);
    if (shot.timing.startSeconds < previousStart) throw new Error("MotionCompositionPlan shots are not in realized timeline order.");
    previousStart = shot.timing.startSeconds;
    motionShotIds.add(shot.shotId);
  }
  for (const segment of realized.segments) {
    const asset = audioById.get(segment.audioAssetId);
    if (!segment || !validAudioAsset(asset, segment) || !validTiming(segment.startSeconds, segment.endSeconds, segment.durationSeconds)) throw new Error("RealizedTimeline contains an unresolved audio segment.");
    if (!motionShotIds.has(segment.shotId)) throw new Error(`MotionCompositionPlan does not contain shot '${segment.shotId}'.`);
  }
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

function validAudioAsset(asset: AudioAssetManifest["assets"][number] | undefined, segment: RealizedTimeline["segments"][number]): boolean {
  return Boolean(asset && nonEmpty(asset.id) && asset.segmentId === segment.id && asset.shotId === segment.shotId && asset.role === segment.role && nonEmpty(asset.voice) && nonEmpty(asset.path) && asset.format === "aiff" && finitePositive(asset.durationSeconds) && /^[a-f0-9]{64}$/.test(asset.sha256) && asset.durationSeconds === segment.durationSeconds);
}

function inferSfx(shotId: string, startSeconds: number, endSeconds: number, intent: string) {
  if (/push-in/i.test(intent)) return [{ id: `SFX_${shotId}_MOTION`, lifecycle: "PLANNED" as const, shotId, startSeconds, endSeconds: Math.min(endSeconds, Number((startSeconds + 0.8).toFixed(3))), description: "subtle cinematic motion swell", gainDb: -24 }];
  return [];
}
function positiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }
function finitePositive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validTiming(start: unknown, end: unknown, duration: unknown): boolean { return [start, end, duration].every(value => typeof value === "number" && Number.isFinite(value)) && (end as number) > (start as number) && (duration as number) > 0 && (duration as number) === (end as number) - (start as number); }
function sameTiming(left: { startSeconds: number; endSeconds: number; durationSeconds: number }, right: { startSeconds: number; endSeconds: number; durationSeconds: number }): boolean { return left.startSeconds === right.startSeconds && left.endSeconds === right.endSeconds && left.durationSeconds === right.durationSeconds; }
function finiteUnit(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
