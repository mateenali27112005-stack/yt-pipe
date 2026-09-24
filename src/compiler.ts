import { createHash } from "node:crypto";
import type { EntityRegistry, EpisodeSpec, Finding, ParsedEpisode, ValidationReport } from "./types.ts";

const id = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(normalize(value)).digest("hex").slice(0, 10).toUpperCase()}`;
const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

export interface CompileOptions {
  episodeId?: string;
  seriesId: string;
  specVersion?: number;
  parentSpecVersion?: number;
  registry?: EntityRegistry;
  generatedAt?: Date;
}

export function compileEpisode(parsed: ParsedEpisode, parserFindings: Finding[], options: CompileOptions): { episode: EpisodeSpec; report: ValidationReport } {
  const findings = [...parserFindings];
  const { episodeId = "EP_001", seriesId, specVersion = 1, parentSpecVersion, registry: known, generatedAt = new Date() } = options;
  if (!Number.isInteger(specVersion) || specVersion < 1) findings.push(error("INVALID_SPEC_VERSION", "Spec version must be a positive integer."));
  if (parentSpecVersion !== undefined && (!Number.isInteger(parentSpecVersion) || parentSpecVersion < 1 || parentSpecVersion >= specVersion)) {
    findings.push(error("INVALID_PARENT_SPEC_VERSION", "Parent spec version must be a positive integer lower than the current spec version."));
  }
  const characters = new Map<string, { id: string; name: string }>();
  const locations = new Map<string, { id: string; name: string }>();
  const knownCharacters = new Set((known?.characters ?? []).map(normalize));
  const knownLocations = new Set((known?.locations ?? []).map(normalize));
  const registerCharacter = (name: string, line: number) => {
    const key = normalize(name);
    if (known && !knownCharacters.has(key)) findings.push(error("UNRESOLVED_CHARACTER", `Character '${name}' is not in the supplied series bible.`, line));
    if (!characters.has(key)) characters.set(key, { id: id("CHAR", name), name });
    return characters.get(key)!;
  };
  const registerLocation = (name: string, line: number) => {
    const key = normalize(name);
    if (known && !knownLocations.has(key)) findings.push(error("UNRESOLVED_LOCATION", `Location '${name}' is not in the supplied series bible.`, line));
    if (!locations.has(key)) locations.set(key, { id: id("LOC", name), name });
    return locations.get(key)!;
  };
  const scenes = parsed.scenes.map((scene, sceneIndex) => {
    if (!scene.location) findings.push(error("MISSING_LOCATION", "Every Scene needs a Location.", scene.line));
    if (!scene.purpose) findings.push(error("MISSING_SCENE_PURPOSE", "Every Scene needs a Purpose.", scene.line));
    if (scene.shots.length === 0) findings.push(error("MISSING_SHOT", "Every Scene needs at least one Shot.", scene.line));
    const location = registerLocation(scene.location ?? "unresolved-location", scene.line);
    const stableSceneId = `SC_${String(sceneIndex + 1).padStart(3, "0")}`;
    return {
      id: stableSceneId,
      order: sceneIndex + 1,
      title: scene.title,
      location,
      ...(scene.time ? { time: scene.time } : {}),
      purpose: scene.purpose ?? "",
      shots: scene.shots.map((shot, shotIndex) => {
        if (!shot.purpose) findings.push(error("MISSING_SHOT_PURPOSE", "Every Shot needs a Purpose.", shot.line));
        if (!shot.visual) findings.push(error("MISSING_VISUAL", "Every Shot needs a Visual.", shot.line));
        if (shot.characters.length === 0) findings.push(error("MISSING_CHARACTERS", "Every Shot needs at least one Character.", shot.line));
        if (!shot.timing) findings.push(error("MISSING_TIMING", "Every Shot needs Timing.", shot.line));
        if (shot.timing && !(shot.timing.min <= shot.timing.target && shot.timing.target <= shot.timing.max && shot.timing.min > 0)) {
          findings.push(error("INVALID_TIMING_RANGE", "Timing must satisfy 0 < min <= target <= max.", shot.line));
        }
        const characterIds = shot.characters.map(name => registerCharacter(name, shot.line).id);
        return {
          id: `SH_${String(sceneIndex + 1).padStart(3, "0")}_${String(shotIndex + 1).padStart(3, "0")}`,
          order: shotIndex + 1,
          purpose: shot.purpose ?? "",
          characterIds,
          ...(shot.narration ? { narration: shot.narration } : {}),
          ...(shot.dialogue ? { dialogue: shot.dialogue } : {}),
          visual: shot.visual ?? "",
          plannedTiming: shot.timing ?? { min: 0, target: 0, max: 0 }
        };
      })
    };
  });
  const errors = findings.filter(f => f.severity === "error").length;
  const warnings = findings.filter(f => f.severity === "warning").length;
  const info = findings.filter(f => f.severity === "info").length;
  const episode: EpisodeSpec = {
    schemaVersion: "0.1", specVersion, ...(parentSpecVersion ? { parentSpecVersion } : {}), lifecycle: errors ? "DRAFT" : "VALIDATED",
    episode: { id: episodeId, title: parsed.title ?? "", seriesId },
    registry: { characters: [...characters.values()].sort((a, b) => a.id.localeCompare(b.id)), locations: [...locations.values()].sort((a, b) => a.id.localeCompare(b.id)) },
    scenes,
    provenance: { parser: "episode-production-agent", parserVersion: "0.1.0" }
  };
  return { episode, report: { schemaVersion: "0.1", status: errors ? "FAIL" : "APPROVABLE", generatedAt: generatedAt.toISOString(), summary: { errors, warnings, info }, findings, provenance: { validator: "episode-production-agent", validatorVersion: "0.1.0" } } };
}

function error(code: string, message: string, line?: number): Finding { return { code, severity: "error", message, line }; }
