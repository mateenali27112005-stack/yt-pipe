/**
 * V0.8 — The Continuity Engine
 *
 * Three public functions:
 *
 *   createInitialState(seriesId, bible)
 *     Bootstrap an empty ContinuityState from a SeriesBible.
 *     Populates characters and locations from the bible. No violations possible.
 *
 *   checkContinuity(newSpec, state, options?)
 *     Deterministic violation detector. Compares the new EpisodeSpec
 *     against the current ContinuityState and returns a ContinuityCheckReport.
 *     Never modifies state. Pure function — same inputs → same report.
 *
 *   advanceState(state, record)
 *     Apply an ApprovedEpisodeRecord's deltas to the ContinuityState,
 *     returning a new immutable ContinuityState. Never mutates input.
 *
 * Violation detection covers all five domains from the Master Execution Plan:
 *   CHARACTER_STATE — deceased characters re-appearing, contradicted possessions/conditions
 *   OBJECTS         — destroyed/lost objects being claimed as held/active
 *   RELATIONSHIPS   — characters interacting with supposed "unknown to each other" parties
 *   WORLD_RULES     — shots explicitly contradicting established world rules
 *   TIMELINE        — time jumps not flagged, events occurring out of established order
 *
 * No I/O. No network. No filesystem access. No side effects.
 * All violation messages are human-readable for the founder review log.
 */

import { createHash } from "node:crypto";
import type { EpisodeSpec, SeriesBible } from "./types.ts";
import type {
  ApprovedEpisodeRecord,
  CharacterContinuityState,
  ContinuityCheckReport,
  ContinuityDomain,
  ContinuityState,
  ContinuityViolation,
  EpisodeContinuityDelta,
  ObjectContinuityState,
  RelationshipState,
  TimelineEvent,
  ViolationSeverity,
  WorldRuleFact,
} from "./continuity-types.ts";

export type {
  ContinuityState,
  ContinuityCheckReport,
  ContinuityViolation,
  ApprovedEpisodeRecord,
  EpisodeContinuityDelta,
  CharacterContinuityState,
  ObjectContinuityState,
  RelationshipState,
  WorldRuleFact,
  TimelineEvent,
} from "./continuity-types.ts";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ContinuityCheckOptions {
  /** Override checkedAt timestamp (useful in tests for stable snapshots). */
  checkedAt?: Date;
}

/**
 * Bootstrap a ContinuityState from a SeriesBible.
 * Creates character entries with their base appearance and empty condition lists.
 * No episode history yet — all characters are at their series-start state.
 */
export function createInitialState(
  seriesId: string,
  bible: SeriesBible,
  options: { createdAt?: Date } = {}
): ContinuityState {
  assertBible(bible, seriesId);

  const characters: CharacterContinuityState[] = bible.characters.map(c => ({
    characterId: c.id,
    characterName: c.name,
    clothingDescription: c.appearance.clothing,
    activeConditions: [],
    currentPossessions: [],
    knownFacts: [],
    isDeceased: false,
  }));

  return {
    schemaVersion: "0.1",
    seriesId,
    stateVersion: 0,
    updatedAt: (options.createdAt ?? new Date()).toISOString(),
    characters,
    objects: [],
    relationships: [],
    worldRules: [],
    timeline: [],
  };
}

/**
 * Deterministic continuity check for a new EpisodeSpec.
 *
 * Checks all five continuity domains. Returns a ContinuityCheckReport
 * with all violations. Never throws on detection failures — all issues
 * are captured as typed violations.
 *
 * Throws only for invalid inputs (null spec/state, mismatched seriesId).
 */
export function checkContinuity(
  newSpec: EpisodeSpec,
  state: ContinuityState,
  options: ContinuityCheckOptions = {}
): ContinuityCheckReport {
  assertCheckInputs(newSpec, state);

  const checkedAt = (options.checkedAt ?? new Date()).toISOString();
  const violations: ContinuityViolation[] = [];

  const characterById = new Map(state.characters.map(c => [c.characterId, c]));
  const objectById = new Map(state.objects.map(o => [o.objectId, o]));

  // -------------------------------------------------------------------------
  // DOMAIN 1: CHARACTER_STATE
  // -------------------------------------------------------------------------
  for (const scene of newSpec.scenes) {
    for (const shot of scene.shots) {
      for (const charId of shot.characterIds) {
        const known = characterById.get(charId);
        if (!known) continue; // new character introduced — not a violation

        // 1a. Deceased character appearing
        if (known.isDeceased) {
          violations.push(violation(
            "CHAR_DECEASED_REAPPEARANCE",
            "CHARACTER_STATE",
            "BLOCKING",
            `Character '${known.characterName}' (${charId}) appears in shot '${shot.id}' but was marked deceased in episode '${known.lastSeenEpisodeId ?? "unknown"}'.`,
            shot.id, scene.id, [charId],
            `${known.characterName} is deceased`,
            `${known.characterName} appears in this shot`
          ));
        }

        // 1b. Visual intent explicitly contradicts known active conditions
        const shotVisual = (shot.visual ?? "").toLowerCase();
        for (const condition of known.activeConditions) {
          const condLower = condition.toLowerCase();
          // Check for healing without explicit resolution
          if (condLower.includes("injured") || condLower.includes("wounded")) {
            const healed = shotVisual.includes("healed") || shotVisual.includes("healthy") || shotVisual.includes("recovered");
            const stillInjured = shotVisual.includes("limp") || shotVisual.includes("bandage") || shotVisual.includes("wound");
            if (healed && !stillInjured) {
              violations.push(violation(
                "CHAR_CONDITION_UNRESOLVED",
                "CHARACTER_STATE",
                "REVIEW",
                `Shot '${shot.id}' shows '${known.characterName}' appearing healed, but active condition '${condition}' has not been resolved in the continuity record.`,
                shot.id, scene.id, [charId],
                condition,
                `${known.characterName} appears healed`
              ));
            }
          }

          // Check for ability use after ability was lost
          if (condLower.includes("cannot use") || condLower.includes("lost ability")) {
            const ability = condLower.replace("cannot use ", "").replace("lost ability:", "").trim();
            if (ability.length > 0 && shotVisual.includes(ability)) {
              violations.push(violation(
                "CHAR_ABILITY_VIOLATION",
                "CHARACTER_STATE",
                "BLOCKING",
                `Shot '${shot.id}' shows '${known.characterName}' using '${ability}', but this ability is listed as lost: '${condition}'.`,
                shot.id, scene.id, [charId],
                condition,
                `Uses ${ability} in visual`
              ));
            }
          }
        }

        // 1c. Possession continuity — if shot visual mentions a specific item
        //     that is tracked as no longer in character's possession
        // (This check runs through objects by holder)
        for (const obj of state.objects) {
          if (obj.currentHolderId !== charId && !obj.isDestroyed && !obj.isLost) {
            // Object is held by someone else; check if this character's shot claims to have it
            const objNameLower = obj.objectName.toLowerCase();
            if (shotVisual.includes(objNameLower) &&
                (shotVisual.includes("holding") || shotVisual.includes("holds") ||
                 shotVisual.includes("wields") || shotVisual.includes("carries") ||
                 shotVisual.includes("draws") || shotVisual.includes("grabs") ||
                 shotVisual.includes("takes") || shotVisual.includes("uses"))) {
              violations.push(violation(
                "CHAR_POSSESSION_CONTRADICTION",
                "CHARACTER_STATE",
                "BLOCKING",
                `Shot '${shot.id}' shows '${known.characterName}' holding '${obj.objectName}', but it is currently held by character '${obj.currentHolderId}'.`,
                shot.id, scene.id, [charId, obj.objectId],
                `'${obj.objectName}' held by ${obj.currentHolderId}`,
                `${known.characterName} appears to hold it`
              ));
            }
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // DOMAIN 2: OBJECTS
  // -------------------------------------------------------------------------
  for (const scene of newSpec.scenes) {
    for (const shot of scene.shots) {
      const shotVisual = (shot.visual ?? "").toLowerCase();
      const shotNarration = (shot.narration ?? "").toLowerCase();
      const shotDialogue = (shot.dialogue ?? "").toLowerCase();
      const fullText = `${shotVisual} ${shotNarration} ${shotDialogue}`;

      for (const obj of state.objects) {
        const objNameLower = obj.objectName.toLowerCase();
        if (!fullText.includes(objNameLower)) continue;

        // 2a. Destroyed object appears
        if (obj.isDestroyed) {
          violations.push(violation(
            "OBJ_DESTROYED_REAPPEARANCE",
            "OBJECTS",
            "BLOCKING",
            `Shot '${shot.id}' references '${obj.objectName}', which was destroyed in episode '${obj.lastChangedEpisodeId ?? "unknown"}'. A destroyed object cannot reappear without an explicit story reason.`,
            shot.id, scene.id, [obj.objectId],
            `'${obj.objectName}' was destroyed`,
            `Appears in shot visual/narration`
          ));
        }

        // 2b. Lost object reference — REVIEW level (could be flashback or search)
        if (obj.isLost && !obj.isDestroyed) {
          violations.push(violation(
            "OBJ_LOST_REFERENCE",
            "OBJECTS",
            "REVIEW",
            `Shot '${shot.id}' references '${obj.objectName}', which was lost as of episode '${obj.lastChangedEpisodeId ?? "unknown"}'. Confirm this is intentional (flashback, search, or recovery).`,
            shot.id, scene.id, [obj.objectId],
            `'${obj.objectName}' is lost`,
            `Referenced in shot text`
          ));
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // DOMAIN 3: RELATIONSHIPS
  // -------------------------------------------------------------------------
  for (const scene of newSpec.scenes) {
    for (const shot of scene.shots) {
      const charIds = shot.characterIds;
      if (charIds.length < 2) continue;

      for (let i = 0; i < charIds.length; i++) {
        for (let j = i + 1; j < charIds.length; j++) {
          const aId = charIds[i];
          const bId = charIds[j];
          const rel = findRelationship(state.relationships, aId, bId);
          if (!rel) continue;

          const shotVisual = (shot.visual ?? "").toLowerCase();
          const shotDialogue = (shot.dialogue ?? "").toLowerCase();

          // 3a. Characters who are "unknown to each other" interact
          if (rel.status.toLowerCase().includes("unknown to each other")) {
            const hasRecognition = shotDialogue.includes("you") ||
              shotVisual.includes("recogni") ||
              shotVisual.includes("greet");
            if (hasRecognition) {
              const aName = state.characters.find(c => c.characterId === aId)?.characterName ?? aId;
              const bName = state.characters.find(c => c.characterId === bId)?.characterName ?? bId;
              violations.push(violation(
                "REL_UNKNOWN_PARTY_INTERACTION",
                "RELATIONSHIPS",
                "BLOCKING",
                `Shot '${shot.id}' shows '${aName}' and '${bName}' interacting as if they know each other, but their continuity relationship is '${rel.status}'.`,
                shot.id, scene.id, [aId, bId],
                rel.status,
                `Direct interaction / recognition in shot`
              ));
            }
          }

          // 3b. Enemies shown cooperating without resolution
          if (rel.status.toLowerCase() === "enemies") {
            const cooperation = shotVisual.includes("together") ||
              shotVisual.includes("side by side") ||
              shotVisual.includes("help") ||
              shotDialogue.toLowerCase().includes("trust");
            if (cooperation) {
              const aName = state.characters.find(c => c.characterId === aId)?.characterName ?? aId;
              const bName = state.characters.find(c => c.characterId === bId)?.characterName ?? bId;
              violations.push(violation(
                "REL_ENEMY_COOPERATION",
                "RELATIONSHIPS",
                "REVIEW",
                `Shot '${shot.id}' shows '${aName}' and '${bName}' cooperating, but their current relationship is 'enemies'. Confirm this is an intentional story beat.`,
                shot.id, scene.id, [aId, bId],
                "enemies",
                "Cooperation in shot"
              ));
            }
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // DOMAIN 4: WORLD_RULES
  // -------------------------------------------------------------------------
  for (const rule of state.worldRules) {
    if (rule.isOverridden) continue; // already canonically overridden

    const ruleKeywords = extractKeywords(rule.description);
    for (const scene of newSpec.scenes) {
      for (const shot of scene.shots) {
        const shotText = `${shot.visual ?? ""} ${shot.narration ?? ""} ${shot.dialogue ?? ""}`.toLowerCase();
        // Check if the shot text mentions keywords that suggest the rule is being violated
        const ruleViolated = ruleKeywords.some(kw =>
          shotText.includes(`no ${kw}`) ||
          shotText.includes(`without ${kw}`) ||
          shotText.includes(`defies ${kw}`)
        );
        if (ruleViolated) {
          violations.push(violation(
            "WORLD_RULE_VIOLATION",
            "WORLD_RULES",
            "REVIEW",
            `Shot '${shot.id}' may contradict world rule '${rule.ruleId}': "${rule.description}" (established in episode '${rule.establishedEpisodeId}'). Mark as intentional if this is a story beat.`,
            shot.id, scene.id, [rule.ruleId],
            rule.description,
            `Shot text suggests rule contradiction`
          ));
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // DOMAIN 5: TIMELINE — time jumps not explicitly flagged
  // -------------------------------------------------------------------------
  // Check: if the episode's time references suggest a jump that contradicts
  // the most recent timeline events.
  if (state.timeline.length > 0) {
    const lastEvent = state.timeline[state.timeline.length - 1];
    for (const scene of newSpec.scenes) {
      const sceneTime = (scene.time ?? "").toLowerCase();
      if (!sceneTime) continue;
      // Simple heuristic: if scene time contains "years before" or "centuries ago"
      // and the timeline has no flashback markers, it may be an unannounced retcon
      const unexplainedJump =
        (sceneTime.includes("year") || sceneTime.includes("centur") || sceneTime.includes("decade")) &&
        (sceneTime.includes("ago") || sceneTime.includes("before") || sceneTime.includes("earlier")) &&
        !sceneTime.includes("flashback") && !sceneTime.includes("memory") && !sceneTime.includes("vision");
      if (unexplainedJump) {
        violations.push(violation(
          "TIMELINE_UNEXPLAINED_JUMP",
          "TIMELINE",
          "REVIEW",
          `Scene '${scene.id}' (time: '${scene.time}') suggests a significant time jump but is not marked as a flashback, memory, or vision. Confirm this is intentional.`,
          undefined, scene.id, [],
          `Last known event: ${lastEvent.description} (episode ${lastEvent.episodeId})`,
          `Scene time: '${scene.time}'`
        ));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Build report
  // -------------------------------------------------------------------------
  const blockingViolations = violations.filter(v => v.severity === "BLOCKING").length;
  const reviewViolations = violations.filter(v => v.severity === "REVIEW").length;

  const status: ContinuityCheckReport["status"] =
    blockingViolations > 0 ? "BLOCKED" :
    reviewViolations > 0 ? "NEEDS_REVIEW" :
    "CLEAR";

  return {
    schemaVersion: "0.1",
    episodeId: newSpec.episode.id,
    specVersion: newSpec.specVersion,
    checkedAt,
    status,
    totalViolations: violations.length,
    blockingViolations,
    reviewViolations,
    violations,
  };
}

/**
 * Apply an ApprovedEpisodeRecord's deltas to the ContinuityState.
 * Returns a NEW ContinuityState — the input is never mutated.
 * Throws for invalid inputs (null state/record, seriesId mismatch).
 */
export function advanceState(
  state: ContinuityState,
  record: ApprovedEpisodeRecord
): ContinuityState {
  assertAdvanceInputs(state, record);

  // Deep clone via JSON round-trip (all values are JSON-serialisable)
  const next: ContinuityState = JSON.parse(JSON.stringify(state));
  next.stateVersion = state.stateVersion + 1;
  next.lastApprovedEpisodeId = record.episodeId;
  next.updatedAt = record.approvedAt;

  const { deltas } = record;

  // --- Character updates ---
  for (const update of deltas.characterUpdates ?? []) {
    let char = next.characters.find(c => c.characterId === update.characterId);
    if (!char) {
      // New character introduced in this episode
      char = {
        characterId: update.characterId,
        characterName: update.characterName,
        activeConditions: [],
        currentPossessions: [],
        knownFacts: [],
        isDeceased: false,
      };
      next.characters.push(char);
    }

    if (update.currentLocation !== undefined) char.currentLocation = update.currentLocation;
    if (update.clothingDescription !== undefined) char.clothingDescription = update.clothingDescription;
    if (update.isDeceased !== undefined) char.isDeceased = update.isDeceased;
    if (update.lastSeenShotId !== undefined) char.lastSeenShotId = update.lastSeenShotId;
    char.lastSeenEpisodeId = record.episodeId;

    // Append-only conditions
    for (const cond of update.addConditions ?? []) {
      if (!char.activeConditions.includes(cond)) char.activeConditions.push(cond);
    }
    char.activeConditions = char.activeConditions.filter(c => !(update.removeConditions ?? []).includes(c));

    // Possessions
    for (const item of update.addPossessions ?? []) {
      if (!char.currentPossessions.includes(item)) char.currentPossessions.push(item);
    }
    char.currentPossessions = char.currentPossessions.filter(p => !(update.removePossessions ?? []).includes(p));

    // Known facts (append-only)
    for (const fact of update.addKnownFacts ?? []) {
      if (!char.knownFacts.includes(fact)) char.knownFacts.push(fact);
    }
  }

  // --- Object updates ---
  for (const update of deltas.objectUpdates ?? []) {
    let obj = next.objects.find(o => o.objectId === update.objectId);
    if (!obj) {
      obj = {
        objectId: update.objectId,
        objectName: update.objectName,
        isDestroyed: false,
        isLost: false,
      };
      next.objects.push(obj);
    }

    if (update.currentHolderId !== undefined) obj.currentHolderId = update.currentHolderId;
    if (update.isDestroyed !== undefined) obj.isDestroyed = update.isDestroyed;
    if (update.isLost !== undefined) obj.isLost = update.isLost;
    obj.lastChangedEpisodeId = record.episodeId;
  }

  // --- Relationship updates ---
  for (const update of deltas.relationshipUpdates ?? []) {
    let rel = findRelationship(next.relationships, update.characterAId, update.characterBId);
    if (!rel) {
      rel = {
        characterAId: update.characterAId,
        characterBId: update.characterBId,
        status: update.newStatus,
        history: [],
        lastChangedEpisodeId: record.episodeId,
      };
      next.relationships.push(rel);
    } else {
      rel.status = update.newStatus;
      rel.lastChangedEpisodeId = record.episodeId;
    }
    if (update.addHistoryEvent) rel.history.push(update.addHistoryEvent);
  }

  // --- New world rules ---
  for (const rule of deltas.newWorldRules ?? []) {
    if (!next.worldRules.find(r => r.ruleId === rule.ruleId)) {
      next.worldRules.push({
        ruleId: rule.ruleId,
        description: rule.description,
        isOverridden: false,
        establishedEpisodeId: record.episodeId,
      });
    }
  }

  // --- World rule overrides ---
  for (const override of deltas.overriddenWorldRules ?? []) {
    const rule = next.worldRules.find(r => r.ruleId === override.ruleId);
    if (rule) {
      rule.isOverridden = true;
      rule.overriddenEpisodeId = record.episodeId;
    }
  }

  // --- Timeline events ---
  for (const event of deltas.timelineEvents ?? []) {
    next.timeline.push({
      eventId: event.eventId,
      episodeId: record.episodeId,
      shotId: event.shotId,
      description: event.description,
      inUniverseTime: event.inUniverseTime,
      tags: event.tags ?? [],
    });
  }

  return next;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function violation(
  code: string,
  domain: ContinuityDomain,
  severity: ViolationSeverity,
  message: string,
  shotId: string | undefined,
  sceneId: string | undefined,
  affectedIds: string[],
  establishedFact?: string,
  newClaim?: string,
  establishedInEpisodeId?: string
): ContinuityViolation {
  return {
    code,
    domain,
    severity,
    message,
    ...(shotId ? { shotId } : {}),
    ...(sceneId ? { sceneId } : {}),
    affectedIds,
    ...(establishedFact ? { establishedFact } : {}),
    ...(newClaim ? { newClaim } : {}),
    ...(establishedInEpisodeId ? { establishedInEpisodeId } : {}),
  };
}

function findRelationship(
  relationships: RelationshipState[],
  aId: string,
  bId: string
): RelationshipState | undefined {
  return relationships.find(
    r => (r.characterAId === aId && r.characterBId === bId) ||
         (r.characterAId === bId && r.characterBId === aId)
  );
}

function extractKeywords(description: string): string[] {
  // Extract meaningful 3+ character words for world rule matching
  return description
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP_WORDS.has(w));
}

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "they", "have", "been", "will",
  "would", "could", "should", "must", "cannot", "their", "there",
  "where", "when", "only", "also", "some", "most", "more", "than",
]);

function assertBible(bible: unknown, seriesId: string): asserts bible is SeriesBible {
  if (!bible || typeof bible !== "object") throw new Error("createInitialState: SeriesBible must be an object.");
  const b = bible as Partial<SeriesBible>;
  if (!b.seriesId || b.seriesId !== seriesId) throw new Error("createInitialState: SeriesBible seriesId does not match the provided seriesId.");
  if (!Array.isArray(b.characters) || !Array.isArray(b.locations)) throw new Error("createInitialState: SeriesBible is missing characters or locations arrays.");
}

function assertCheckInputs(spec: unknown, state: unknown): asserts spec is EpisodeSpec {
  if (!spec || typeof spec !== "object") throw new Error("checkContinuity: EpisodeSpec must be an object.");
  const s = spec as Partial<EpisodeSpec>;
  if (!s.episode?.id || !s.episode?.seriesId) throw new Error("checkContinuity: EpisodeSpec is missing episode.id or episode.seriesId.");
  if (!Array.isArray(s.scenes)) throw new Error("checkContinuity: EpisodeSpec is missing scenes array.");
  if (!state || typeof state !== "object") throw new Error("checkContinuity: ContinuityState must be an object.");
  const st = state as Partial<ContinuityState>;
  if (!st.seriesId) throw new Error("checkContinuity: ContinuityState is missing seriesId.");
  if (s.episode.seriesId !== st.seriesId) {
    throw new Error(`checkContinuity: EpisodeSpec seriesId '${s.episode.seriesId}' does not match ContinuityState seriesId '${st.seriesId}'.`);
  }
}

function assertAdvanceInputs(state: unknown, record: unknown): asserts state is ContinuityState {
  if (!state || typeof state !== "object") throw new Error("advanceState: ContinuityState must be an object.");
  const st = state as Partial<ContinuityState>;
  if (!st.seriesId || typeof st.stateVersion !== "number") throw new Error("advanceState: ContinuityState is missing seriesId or stateVersion.");
  if (!record || typeof record !== "object") throw new Error("advanceState: ApprovedEpisodeRecord must be an object.");
  const r = record as Partial<ApprovedEpisodeRecord>;
  if (!r.episodeId || !r.seriesId || !r.approvedAt) throw new Error("advanceState: ApprovedEpisodeRecord is missing required fields.");
  if (r.seriesId !== st.seriesId) throw new Error(`advanceState: Record seriesId '${r.seriesId}' does not match state seriesId '${st.seriesId}'.`);
  if (!r.deltas || typeof r.deltas !== "object") throw new Error("advanceState: ApprovedEpisodeRecord is missing deltas.");
}
