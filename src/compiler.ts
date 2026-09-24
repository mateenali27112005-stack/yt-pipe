import { createHash } from "node:crypto";
import type { EntityRegistry, EpisodeSpec, Finding, ParsedEpisode, ValidationReport } from "./types.ts";

const id = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(normalize(value)).digest("hex").slice(0, 10).toUpperCase()}`;
const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");

export function compileEpisode(parsed: ParsedEpisode, parserFindings: Finding[], seriesId: string, known?: EntityRegistry): { episode: EpisodeSpec; report: ValidationReport } {
  const findings = [...parserFindings];
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
    const stableSceneId = id("SC", `${scene.title}|${scene.location ?? ""}|${scene.purpose ?? ""}`);
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
          id: id("SH", `${stableSceneId}|${shot.purpose ?? ""}|${shot.visual ?? ""}|${shot.narration ?? ""}|${shot.dialogue ?? ""}`),
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
    schemaVersion: "0.1", specVersion: "1", lifecycle: errors ? "DRAFT" : "VALIDATED",
    episode: { id: id("EP", parsed.title ?? "unresolved-episode"), title: parsed.title ?? "", seriesId },
    registry: { characters: [...characters.values()].sort((a, b) => a.id.localeCompare(b.id)), locations: [...locations.values()].sort((a, b) => a.id.localeCompare(b.id)) },
    scenes,
    provenance: { parser: "episode-production-agent", parserVersion: "0.1.0" }
  };
  return { episode, report: { schemaVersion: "0.1", status: errors ? "FAIL" : "APPROVABLE", generatedAt: new Date(0).toISOString(), summary: { errors, warnings, info }, findings, provenance: { validator: "episode-production-agent", validatorVersion: "0.1.0" } } };
}

function error(code: string, message: string, line?: number): Finding { return { code, severity: "error", message, line }; }
