import { createHash } from "node:crypto";
import { assertSeriesBible, assertSeriesBibleMatchesEpisode, resolveShotVisualContext } from "./series-bible.ts";
import type { AssetManifest, EpisodeSpec, RealizedTimeline, SeriesBible, ShotVisualSpec, VisualProfile } from "./types.ts";

export interface VisualPlanOptions {
  profile: VisualProfile;
  seriesBible?: SeriesBible;
  visualSpecVersion?: number;
  generatedAt?: Date;
}

export function createVisualPlan(spec: EpisodeSpec, timeline: RealizedTimeline, options: VisualPlanOptions): { visualSpec: ShotVisualSpec; manifest: AssetManifest } {
  assertVisualPlanInputs(spec, timeline, options.profile);
  if (options.seriesBible) {
    assertSeriesBible(options.seriesBible);
    assertSeriesBibleMatchesEpisode(spec, options.seriesBible);
  }
  const visualSpecVersion = options.visualSpecVersion ?? 1;
  if (!Number.isInteger(visualSpecVersion) || visualSpecVersion < 1) throw new Error("Visual spec version must be a positive integer.");
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const timingByShot = collectShotTiming(timeline);
  const shots = spec.scenes.flatMap(scene => scene.shots.map(shot => {
    const continuity = options.seriesBible ? resolveShotVisualContext({ characterIds: shot.characterIds, locationId: scene.location.id, styleReference: options.profile.styleReference }, options.seriesBible) : undefined;
    const visual = {
      id: `VSP_${shot.id}`,
      sceneId: scene.id,
      shotId: shot.id,
      characterIds: [...shot.characterIds],
      locationId: scene.location.id,
      visualIntent: shot.visual,
      framing: inferFraming(shot.visual),
      action: shot.purpose,
      expression: inferExpression(shot.visual),
      lighting: inferLighting(shot.visual, options.profile.defaultLighting),
      mood: inferMood(shot.visual, options.profile.defaultMood),
      cameraIntent: inferCameraIntent(shot.visual, options.profile.defaultCameraIntent),
      styleReference: options.profile.styleReference,
      ...(continuity ? { continuity } : {}),
      ...(timingByShot.get(shot.id) ? { realizedTiming: timingByShot.get(shot.id) } : {}),
      sourceHash: hash({ sceneId: scene.id, shotId: shot.id, visual: shot.visual, purpose: shot.purpose, characterIds: shot.characterIds, locationId: scene.location.id, timelineVersion: timeline.timelineVersion, timing: timingByShot.get(shot.id) ?? null, profile: options.profile, continuity })
    };
    return visual;
  }));
  const visualSpec: ShotVisualSpec = { schemaVersion: "0.1", visualSpecVersion, episodeId: spec.episode.id, sourceSpecVersion: spec.specVersion, sourceTimelineVersion: timeline.timelineVersion, ...(options.seriesBible ? { sourceSeriesBibleVersion: options.seriesBible.bibleVersion } : {}), generatedAt, shots };
  const manifest: AssetManifest = {
    schemaVersion: "0.1", manifestRevision: 1, episodeId: spec.episode.id, sourceSpecVersion: spec.specVersion, sourceVisualSpecVersion: visualSpec.visualSpecVersion, ...(options.seriesBible ? { sourceSeriesBibleVersion: options.seriesBible.bibleVersion } : {}), generatedAt,
    assets: shots.map(shot => ({ id: `VAS_${shot.shotId}`, shotId: shot.shotId, shotVisualSpecId: shot.id, activeVersionId: `VAS_${shot.shotId}_v1`, versions: [{ id: `VAS_${shot.shotId}_v1`, version: 1, lifecycle: "PLANNED", createdAt: generatedAt }] }))
  };
  assertAssetManifest(manifest);
  return { visualSpec, manifest };
}

export function regenerateVisualAsset(manifest: AssetManifest, assetId: string, generatedAt = new Date()): AssetManifest {
  assertAssetManifest(manifest);
  const asset = manifest.assets.find(candidate => candidate.id === assetId);
  if (!asset) throw new Error(`Visual asset '${assetId}' does not exist in the manifest.`);
  const version = Math.max(...asset.versions.map(candidate => candidate.version)) + 1;
  const previousActive = asset.activeVersionId;
  const createdAt = generatedAt.toISOString();
  const assets = manifest.assets.map(candidate => candidate.id === assetId ? {
    ...candidate,
    activeVersionId: `${candidate.id}_v${version}`,
    versions: [...candidate.versions, { id: `${candidate.id}_v${version}`, version, lifecycle: "PLANNED" as const, createdAt, supersedesVersionId: previousActive }]
  } : candidate);
  const next: AssetManifest = { ...manifest, manifestRevision: manifest.manifestRevision + 1, generatedAt: createdAt, assets };
  assertAssetManifest(next);
  return next;
}

export function assertVisualPlanInputs(spec: unknown, timeline: unknown, profile: unknown): asserts spec is EpisodeSpec & { lifecycle: "VALIDATED" } {
  if (!spec || typeof spec !== "object") throw new Error("Visual planning requires an EpisodeSpec JSON object.");
  const episode = spec as Partial<EpisodeSpec>;
  if (episode.schemaVersion !== "0.1" || episode.lifecycle !== "VALIDATED") throw new Error("Visual planning requires an EpisodeSpec with schemaVersion '0.1' and lifecycle VALIDATED.");
  if (!episode.episode?.id || !Number.isInteger(episode.specVersion) || !Array.isArray(episode.scenes)) throw new Error("EpisodeSpec is missing required visual-planning fields.");
  if (!timeline || typeof timeline !== "object") throw new Error("Visual planning requires a RealizedTimeline JSON object.");
  const realized = timeline as Partial<RealizedTimeline>;
  if (realized.schemaVersion !== "0.1" || !Number.isInteger(realized.timelineVersion) || (realized.timelineVersion ?? 0) < 1 || realized.episodeId !== episode.episode.id || realized.sourceSpecVersion !== episode.specVersion || !Array.isArray(realized.segments)) throw new Error("RealizedTimeline does not match the EpisodeSpec.");
  if (!profile || typeof profile !== "object") throw new Error("Visual planning requires a VisualProfile JSON object.");
  const visualProfile = profile as Partial<VisualProfile>;
  for (const field of ["styleReference", "defaultLighting", "defaultMood", "defaultCameraIntent"] as const) if (typeof visualProfile[field] !== "string" || !visualProfile[field].trim()) throw new Error(`VisualProfile requires a non-empty '${field}'.`);
  const characterIds = new Set(episode.registry?.characters.map(character => character.id));
  const locationIds = new Set(episode.registry?.locations.map(location => location.id));
  const shotIds = new Set<string>();
  for (const scene of episode.scenes) {
    if (!scene || typeof scene.id !== "string" || !scene.location || !locationIds.has(scene.location.id) || !Array.isArray(scene.shots)) throw new Error("EpisodeSpec contains an invalid or unresolved scene location.");
    for (const shot of scene.shots) {
      if (!shot || typeof shot.id !== "string" || !shot.visual?.trim() || !shot.purpose?.trim() || !Array.isArray(shot.characterIds) || shot.characterIds.some(id => !characterIds.has(id))) throw new Error("EpisodeSpec contains an invalid or unresolved shot visual reference.");
      shotIds.add(shot.id);
    }
  }
  for (const segment of realized.segments) {
    if (!segment || !shotIds.has(segment.shotId) || !validTiming(segment.startSeconds, segment.endSeconds, segment.durationSeconds)) throw new Error("RealizedTimeline contains an invalid or unresolved segment.");
  }
}

export function assertAssetManifest(value: unknown): asserts value is AssetManifest {
  if (!value || typeof value !== "object") throw new Error("AssetManifest must be a JSON object.");
  const manifest = value as Partial<AssetManifest>;
  if (manifest.schemaVersion !== "0.1" || !Number.isInteger(manifest.manifestRevision) || (manifest.manifestRevision ?? 0) < 1 || !Array.isArray(manifest.assets)) throw new Error("AssetManifest is missing required fields.");
  const assetIds = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset || !asset.id || !asset.shotId || !asset.shotVisualSpecId || !asset.activeVersionId || !Array.isArray(asset.versions) || asset.versions.length === 0) throw new Error("AssetManifest contains an invalid visual asset.");
    if (assetIds.has(asset.id)) throw new Error(`AssetManifest contains duplicate asset '${asset.id}'.`);
    assetIds.add(asset.id);
    const active = asset.versions.filter(version => version.id === asset.activeVersionId);
    if (active.length !== 1) throw new Error(`Visual asset '${asset.id}' must designate exactly one active version.`);
    const seenVersions = new Set<number>();
    for (const version of asset.versions) {
      if (!version.id || !Number.isInteger(version.version) || version.version < 1 || !["PLANNED", "GENERATED"].includes(version.lifecycle) || seenVersions.has(version.version)) throw new Error(`Visual asset '${asset.id}' has invalid versions.`);
      if (version.lifecycle === "GENERATED" && (!version.output || version.output.format !== "png" || !version.output.path || version.output.byteLength <= 0 || !/^[a-f0-9]{64}$/.test(version.output.sha256) || !version.provider?.name || !version.provider.model || !version.provider.promptHash)) throw new Error(`Generated visual asset '${asset.id}' is missing output provenance.`);
      seenVersions.add(version.version);
    }
  }
}

function collectShotTiming(timeline: RealizedTimeline) {
  const timings = new Map<string, { startSeconds: number; endSeconds: number; durationSeconds: number }>();
  for (const segment of timeline.segments) {
    const current = timings.get(segment.shotId);
    const startSeconds = current ? Math.min(current.startSeconds, segment.startSeconds) : segment.startSeconds;
    const endSeconds = current ? Math.max(current.endSeconds, segment.endSeconds) : segment.endSeconds;
    timings.set(segment.shotId, { startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds });
  }
  return timings;
}

function inferFraming(visual: string) { return /extreme close-up/i.test(visual) ? "extreme close-up" : /close-up/i.test(visual) ? "close-up" : /wide/i.test(visual) ? "wide shot" : /medium/i.test(visual) ? "medium shot" : "medium shot"; }
function inferExpression(visual: string) { const match = visual.match(/\b(fear|afraid|angry|calm|smile|smiling|tense|sad|grief|determined)\b/i); return match ? match[1].toLocaleLowerCase("en-US") : "story-driven expression"; }
function inferLighting(visual: string, fallback: string) { return /\b(light|lighting|glow|illuminat|lantern|shadow|dark|night|blue)\b/i.test(visual) ? "as described in visual intent" : fallback; }
function inferMood(visual: string, fallback: string) { const match = visual.match(/\b(ominous|tense|melancholic|hopeful|dramatic|warm|noir)\b/i); return match ? match[1].toLocaleLowerCase("en-US") : fallback; }
function inferCameraIntent(visual: string, fallback: string) { return /extreme close-up|close-up/i.test(visual) ? "slow push-in" : /wide/i.test(visual) ? "slow establishing hold" : fallback; }
function validTiming(start: unknown, end: unknown, duration: unknown) { return [start, end, duration].every(value => typeof value === "number" && Number.isFinite(value)) && (end as number) >= (start as number) && (duration as number) === (end as number) - (start as number); }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
