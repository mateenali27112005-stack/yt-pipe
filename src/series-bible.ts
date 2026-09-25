import { createHash } from "node:crypto";
import type { EpisodeSpec, ReferenceAsset, ResolvedVisualContext, SeriesBible } from "./types.ts";

export function assertSeriesBible(value: unknown): asserts value is SeriesBible {
  if (!value || typeof value !== "object") throw new Error("SeriesBible must be a JSON object.");
  const bible = value as Partial<SeriesBible>;
  if (bible.schemaVersion !== "0.1" || !positiveInteger(bible.bibleVersion) || !nonEmpty(bible.seriesId) || !Array.isArray(bible.characters) || !Array.isArray(bible.locations) || !Array.isArray(bible.visualStyles)) throw new Error("SeriesBible is missing required fields.");
  assertUniqueRecords(bible.characters, "character", character => character.id, character => character.name);
  assertUniqueRecords(bible.locations, "location", location => location.id, location => location.name);
  assertUniqueRecords(bible.visualStyles, "visual style", style => style.id, style => style.name);
  for (const character of bible.characters) {
    if (!character || !nonEmpty(character.id) || !nonEmpty(character.name) || !character.appearance || ![character.appearance.hair, character.appearance.eyes, character.appearance.build, character.appearance.clothing].every(nonEmpty) || !Array.isArray(character.personalityVisualCues) || character.personalityVisualCues.some(cue => !nonEmpty(cue))) throw new Error("SeriesBible contains an invalid character.");
    assertReferences(character.referenceAssets, character.activeReferenceAssetId, `character '${character.id}'`);
  }
  for (const location of bible.locations) {
    if (!location || !nonEmpty(location.id) || !nonEmpty(location.name) || !nonEmpty(location.visualDescription)) throw new Error("SeriesBible contains an invalid location.");
    assertReferences(location.referenceAssets, location.activeReferenceAssetId, `location '${location.id}'`);
  }
  for (const style of bible.visualStyles) if (!style || !nonEmpty(style.id) || !nonEmpty(style.name) || !nonEmpty(style.promptGuidance) || (style.negativePrompt !== undefined && !nonEmpty(style.negativePrompt))) throw new Error("SeriesBible contains an invalid visual style.");
}

export function assertSeriesBibleMatchesEpisode(spec: EpisodeSpec, bible: SeriesBible): void {
  assertSeriesBible(bible);
  if (bible.seriesId !== spec.episode.seriesId) throw new Error("SeriesBible does not match the EpisodeSpec series.");
  for (const character of spec.registry.characters) {
    const canonical = bible.characters.find(candidate => candidate.id === character.id);
    if (!canonical || canonical.name.localeCompare(character.name, "en-US", { sensitivity: "accent" }) !== 0) throw new Error(`SeriesBible does not resolve character '${character.id}' from the EpisodeSpec registry.`);
  }
  for (const location of spec.registry.locations) {
    const canonical = bible.locations.find(candidate => candidate.id === location.id);
    if (!canonical || canonical.name.localeCompare(location.name, "en-US", { sensitivity: "accent" }) !== 0) throw new Error(`SeriesBible does not resolve location '${location.id}' from the EpisodeSpec registry.`);
  }
}

export function resolveShotVisualContext(input: { characterIds: string[]; locationId: string; styleReference: string }, bible: SeriesBible): ResolvedVisualContext {
  assertSeriesBible(bible);
  const characterReferences = input.characterIds.map(id => {
    const character = bible.characters.find(candidate => candidate.id === id);
    if (!character) throw new Error(`SeriesBible does not resolve character '${id}' for visual continuity.`);
    return {
      id: character.id,
      name: character.name,
      appearance: { ...character.appearance },
      personalityVisualCues: [...character.personalityVisualCues],
      ...(activeReference(character.referenceAssets, character.activeReferenceAssetId) ? { activeReferenceAsset: activeReference(character.referenceAssets, character.activeReferenceAssetId)! } : {})
    };
  });
  const location = bible.locations.find(candidate => candidate.id === input.locationId);
  if (!location) throw new Error(`SeriesBible does not resolve location '${input.locationId}' for visual continuity.`);
  const style = bible.visualStyles.find(candidate => candidate.id === input.styleReference || candidate.name.localeCompare(input.styleReference, "en-US", { sensitivity: "accent" }) === 0);
  if (!style) throw new Error(`SeriesBible does not resolve visual style '${input.styleReference}'.`);
  const context = {
    characterReferences,
    locationReference: {
      id: location.id,
      name: location.name,
      visualDescription: location.visualDescription,
      ...(activeReference(location.referenceAssets, location.activeReferenceAssetId) ? { activeReferenceAsset: activeReference(location.referenceAssets, location.activeReferenceAssetId)! } : {})
    },
    styleReference: { id: style.id, name: style.name, promptGuidance: style.promptGuidance, ...(style.negativePrompt ? { negativePrompt: style.negativePrompt } : {}) }
  };
  return { ...context, sourceHash: hash(context) };
}

function assertUniqueRecords<T>(records: T[], label: string, id: (record: T) => unknown, name: (record: T) => unknown): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const record of records) {
    if (!record || !nonEmpty(id(record)) || !nonEmpty(name(record))) throw new Error(`SeriesBible contains an invalid ${label}.`);
    const recordId = id(record) as string;
    const recordName = (name(record) as string).toLocaleLowerCase("en-US");
    if (ids.has(recordId) || names.has(recordName)) throw new Error(`SeriesBible contains duplicate ${label} identities.`);
    ids.add(recordId);
    names.add(recordName);
  }
}

function assertReferences(references: ReferenceAsset[], activeId: string | undefined, label: string): void {
  if (!Array.isArray(references)) throw new Error(`SeriesBible ${label} has invalid reference assets.`);
  const ids = new Set<string>();
  const versions = new Set<number>();
  for (const reference of references) {
    if (!reference || !nonEmpty(reference.id) || !positiveInteger(reference.version) || !nonEmpty(reference.path) || ids.has(reference.id) || versions.has(reference.version) || (reference.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(reference.sha256))) throw new Error(`SeriesBible ${label} has invalid reference assets.`);
    ids.add(reference.id);
    versions.add(reference.version);
  }
  if (activeId !== undefined && !ids.has(activeId)) throw new Error(`SeriesBible ${label} has an unresolved active reference asset.`);
}

function activeReference(references: ReferenceAsset[], activeId: string | undefined): ReferenceAsset | undefined { return activeId ? references.find(reference => reference.id === activeId) : undefined; }
function positiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
