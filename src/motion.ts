import { createHash } from "node:crypto";
import { assertAssetManifest } from "./visual.ts";
import type { AssetManifest, MotionCompositionPlan, RealizedTimeline, ShotVisualSpec } from "./types.ts";

export interface MotionPlanOptions {
  motionPlanVersion?: number;
  generatedAt?: Date;
  canvas?: { width: number; height: number; frameRate: number };
}

export function createMotionCompositionPlan(timeline: RealizedTimeline, visualSpec: ShotVisualSpec, manifest: AssetManifest, options: MotionPlanOptions = {}): MotionCompositionPlan {
  assertMotionPlanInputs(timeline, visualSpec, manifest);
  const motionPlanVersion = options.motionPlanVersion ?? 1;
  if (!positiveInteger(motionPlanVersion)) throw new Error("Motion plan version must be a positive integer.");
  const canvas = options.canvas ?? { width: 1920, height: 1080, frameRate: 24 };
  if (!positiveInteger(canvas.width) || !positiveInteger(canvas.height) || !positiveInteger(canvas.frameRate)) throw new Error("Motion canvas dimensions and frame rate must be positive integers.");
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const timings = collectShotTiming(timeline);
  const shots = visualSpec.shots.map((shot, index) => {
    const timing = timings.get(shot.shotId);
    if (!timing) throw new Error(`RealizedTimeline does not contain timing for visual shot '${shot.shotId}'.`);
    const asset = manifest.assets.find(candidate => candidate.shotId === shot.shotId && candidate.shotVisualSpecId === shot.id);
    const activeVersion = asset?.versions.find(version => version.id === asset.activeVersionId);
    if (!asset || !activeVersion?.output || activeVersion.lifecycle !== "GENERATED") throw new Error(`Motion compositing requires a GENERATED active visual asset for shot '${shot.shotId}'.`);
    const previous = index > 0 ? visualSpec.shots[index - 1] : undefined;
    const transitionIn = previous ? transition(previous.sceneId === shot.sceneId, timing.startSeconds, timing.durationSeconds) : undefined;
    const camera = cameraFor(shot.cameraIntent);
    return {
      id: `MCP_${shot.shotId}`,
      sceneId: shot.sceneId,
      shotId: shot.shotId,
      visualAsset: { assetId: asset.id, assetVersionId: activeVersion.id, path: activeVersion.output.path, sha256: activeVersion.output.sha256 },
      timing,
      camera,
      ...(transitionIn ? { transitionIn } : {}),
      sourceHash: hash({ shotId: shot.shotId, assetId: asset.id, assetVersionId: activeVersion.id, output: activeVersion.output, timing, camera, transitionIn })
    };
  });
  return {
    schemaVersion: "0.1",
    motionPlanVersion,
    episodeId: timeline.episodeId,
    sourceSpecVersion: timeline.sourceSpecVersion,
    sourceTimelineVersion: timeline.timelineVersion,
    sourceVisualSpecVersion: visualSpec.visualSpecVersion,
    sourceAssetManifestRevision: manifest.manifestRevision,
    ...(visualSpec.sourceSeriesBibleVersion ? { sourceSeriesBibleVersion: visualSpec.sourceSeriesBibleVersion } : {}),
    generatedAt,
    canvas,
    shots
  };
}

export function assertMotionPlanInputs(timeline: unknown, visualSpec: unknown, manifest: unknown): asserts timeline is RealizedTimeline {
  if (!timeline || typeof timeline !== "object") throw new Error("Motion compositing requires a RealizedTimeline JSON object.");
  const realized = timeline as Partial<RealizedTimeline>;
  if (realized.schemaVersion !== "0.1" || !positiveInteger(realized.timelineVersion) || !nonEmpty(realized.episodeId) || !positiveInteger(realized.sourceSpecVersion) || !Array.isArray(realized.segments)) throw new Error("RealizedTimeline is missing required motion-compositing fields.");
  if (!visualSpec || typeof visualSpec !== "object") throw new Error("Motion compositing requires a ShotVisualSpec JSON object.");
  const visual = visualSpec as Partial<ShotVisualSpec>;
  if (visual.schemaVersion !== "0.1" || !positiveInteger(visual.visualSpecVersion) || visual.episodeId !== realized.episodeId || visual.sourceSpecVersion !== realized.sourceSpecVersion || visual.sourceTimelineVersion !== realized.timelineVersion || !Array.isArray(visual.shots)) throw new Error("ShotVisualSpec does not match the RealizedTimeline provenance.");
  assertAssetManifest(manifest);
  const assets = manifest as AssetManifest;
  if (assets.episodeId !== visual.episodeId || assets.sourceSpecVersion !== visual.sourceSpecVersion || assets.sourceVisualSpecVersion !== visual.visualSpecVersion || assets.sourceSeriesBibleVersion !== visual.sourceSeriesBibleVersion) throw new Error("AssetManifest does not match the ShotVisualSpec provenance.");
  const visualShotIds = new Set(visual.shots.map(shot => shot.shotId));
  for (const segment of realized.segments) if (!segment || !visualShotIds.has(segment.shotId) || !validTiming(segment.startSeconds, segment.endSeconds, segment.durationSeconds)) throw new Error("RealizedTimeline contains an invalid or unresolved motion segment.");
}

function collectShotTiming(timeline: RealizedTimeline): Map<string, { startSeconds: number; endSeconds: number; durationSeconds: number }> {
  const timings = new Map<string, { startSeconds: number; endSeconds: number; durationSeconds: number }>();
  for (const segment of timeline.segments) {
    const current = timings.get(segment.shotId);
    const startSeconds = current ? Math.min(current.startSeconds, segment.startSeconds) : segment.startSeconds;
    const endSeconds = current ? Math.max(current.endSeconds, segment.endSeconds) : segment.endSeconds;
    timings.set(segment.shotId, { startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds });
  }
  return timings;
}

function cameraFor(intent: string): MotionCompositionPlan["shots"][number]["camera"] {
  if (/push-in/i.test(intent)) return { intent, keyframes: [{ offset: 0, scale: 1, x: 0.5, y: 0.5 }, { offset: 1, scale: 1.08, x: 0.5, y: 0.5 }] };
  if (/establishing/i.test(intent)) return { intent, keyframes: [{ offset: 0, scale: 1.03, x: 0.5, y: 0.5 }, { offset: 1, scale: 1.03, x: 0.5, y: 0.5 }] };
  return { intent, keyframes: [{ offset: 0, scale: 1, x: 0.5, y: 0.5 }, { offset: 1, scale: 1, x: 0.5, y: 0.5 }] };
}

function transition(sameScene: boolean, atSeconds: number, durationSeconds: number): MotionCompositionPlan["shots"][number]["transitionIn"] {
  return sameScene ? { type: "CUT", atSeconds, durationSeconds: 0 } : { type: "CROSSFADE", atSeconds, durationSeconds: Math.min(0.35, Number((durationSeconds / 4).toFixed(3))) };
}
function positiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function validTiming(start: unknown, end: unknown, duration: unknown): boolean { return [start, end, duration].every(value => typeof value === "number" && Number.isFinite(value)) && (end as number) >= (start as number) && (duration as number) === (end as number) - (start as number); }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
