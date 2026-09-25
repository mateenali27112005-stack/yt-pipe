/**
 * V0.8 Continuity Engine — Deterministic Tests
 *
 * No I/O. No network. No filesystem. No side effects.
 * All test fixtures are constructed in-memory.
 *
 * Covers:
 *   - createInitialState: bootstraps state from SeriesBible
 *   - checkContinuity: all five domains (CHARACTER_STATE, OBJECTS,
 *     RELATIONSHIPS, WORLD_RULES, TIMELINE)
 *   - advanceState: all delta types and immutability guarantee
 *   - Input validation: throws for malformed inputs
 *   - Determinism: same inputs → same report
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialState,
  checkContinuity,
  advanceState,
} from "../src/continuity.ts";
import type {
  ApprovedEpisodeRecord,
  ContinuityState,
} from "../src/continuity.ts";
import type { EpisodeSpec, SeriesBible } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeBible(overrides: Partial<SeriesBible> = {}): SeriesBible {
  return {
    schemaVersion: "0.1",
    bibleVersion: 1,
    seriesId: "SERIES_01",
    generatedAt: "2026-09-26T00:00:00.000Z",
    characters: [
      {
        id: "CHAR_KAEL",
        name: "Kael",
        appearance: {
          hair: "dark",
          eyes: "amber",
          build: "athletic",
          clothing: "dark leather armour",
        },
        personalityVisualCues: ["determined gaze"],
        referenceAssets: [],
      },
      {
        id: "CHAR_MIRA",
        name: "Mira",
        appearance: {
          hair: "silver",
          eyes: "blue",
          build: "slender",
          clothing: "white robes",
        },
        personalityVisualCues: ["serene expression"],
        referenceAssets: [],
      },
    ],
    locations: [
      {
        id: "LOC_TEMPLE",
        name: "Ruined Temple",
        visualDescription: "crumbling stone pillars, ancient symbols",
        referenceAssets: [],
      },
    ],
    visualStyles: [
      {
        id: "STYLE_DARK",
        name: "Dark Fantasy",
        promptGuidance: "cinematic, dark, dramatic lighting",
      },
    ],
    ...overrides,
  };
}

function makeSpec(overrides: {
  episodeId?: string;
  seriesId?: string;
  specVersion?: number;
  shots?: Array<{
    id?: string;
    sceneId?: string;
    order?: number;
    purpose?: string;
    characterIds?: string[];
    visual?: string;
    narration?: string;
    dialogue?: string;
  }>;
  sceneTime?: string;
} = {}): EpisodeSpec {
  const shots = (overrides.shots ?? [
    { id: "SH_001", characterIds: ["CHAR_KAEL"], visual: "Kael stands at the temple entrance" },
  ]).map((s, i) => ({
    id: s.id ?? `SH_00${i + 1}`,
    order: i + 1,
    purpose: s.purpose ?? "establish",
    characterIds: s.characterIds ?? [],
    visual: s.visual ?? "establishing shot",
    narration: s.narration,
    dialogue: s.dialogue,
    plannedTiming: { min: 2, target: 3, max: 5 },
  }));

  return {
    schemaVersion: "0.1",
    specVersion: overrides.specVersion ?? 1,
    lifecycle: "VALIDATED",
    episode: {
      id: overrides.episodeId ?? "EP_002",
      title: "The Test Episode",
      seriesId: overrides.seriesId ?? "SERIES_01",
    },
    registry: {
      characters: [
        { id: "CHAR_KAEL", name: "Kael" },
        { id: "CHAR_MIRA", name: "Mira" },
      ],
      locations: [{ id: "LOC_TEMPLE", name: "Ruined Temple" }],
    },
    scenes: [
      {
        id: "SC_001",
        order: 1,
        title: "Opening",
        location: { id: "LOC_TEMPLE", name: "Ruined Temple" },
        time: overrides.sceneTime,
        purpose: "establish conflict",
        shots,
      },
    ],
    provenance: { parser: "episode-production-agent", parserVersion: "0.1.0" },
  };
}

function makeRecord(
  episodeId: string,
  deltas: ApprovedEpisodeRecord["deltas"] = {}
): ApprovedEpisodeRecord {
  return {
    schemaVersion: "0.1",
    episodeId,
    episodeTitle: `Episode ${episodeId}`,
    seriesId: "SERIES_01",
    specVersion: 1,
    approvedAt: "2026-09-26T00:00:00.000Z",
    deltas,
  };
}

// ---------------------------------------------------------------------------
// createInitialState tests
// ---------------------------------------------------------------------------

test("createInitialState: creates state with correct seriesId and stateVersion 0", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  assert.equal(state.schemaVersion, "0.1");
  assert.equal(state.seriesId, "SERIES_01");
  assert.equal(state.stateVersion, 0);
  assert.equal(state.characters.length, 2);
  assert.equal(state.objects.length, 0);
  assert.equal(state.relationships.length, 0);
  assert.equal(state.worldRules.length, 0);
  assert.equal(state.timeline.length, 0);
});

test("createInitialState: populates characters from SeriesBible", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  const kael = state.characters.find(c => c.characterId === "CHAR_KAEL");
  assert.ok(kael, "Kael should be in state");
  assert.equal(kael!.characterName, "Kael");
  assert.equal(kael!.clothingDescription, "dark leather armour");
  assert.equal(kael!.isDeceased, false);
  assert.deepEqual(kael!.activeConditions, []);
  assert.deepEqual(kael!.currentPossessions, []);
  assert.deepEqual(kael!.knownFacts, []);
});

test("createInitialState: throws when seriesId mismatches bible", () => {
  const bible = makeBible();
  assert.throws(
    () => createInitialState("WRONG_SERIES", bible),
    /seriesId/
  );
});

test("createInitialState: throws for null bible", () => {
  assert.throws(
    () => createInitialState("SERIES_01", null as any),
    /SeriesBible/
  );
});

// ---------------------------------------------------------------------------
// checkContinuity — CLEAR path
// ---------------------------------------------------------------------------

test("checkContinuity: CLEAR for a clean episode with no violations", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  const spec = makeSpec();
  const report = checkContinuity(spec, state);
  assert.equal(report.status, "CLEAR");
  assert.equal(report.totalViolations, 0);
  assert.equal(report.blockingViolations, 0);
  assert.equal(report.episodeId, "EP_002");
  assert.equal(report.schemaVersion, "0.1");
});

test("checkContinuity: is deterministic — same inputs produce same report", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  const spec = makeSpec();
  const t1 = new Date("2026-09-26T10:00:00Z");
  const t2 = new Date("2026-09-26T11:00:00Z");
  const r1 = checkContinuity(spec, state, { checkedAt: t1 });
  const r2 = checkContinuity(spec, state, { checkedAt: t2 });
  assert.notEqual(r1.checkedAt, r2.checkedAt);
  assert.equal(r1.status, r2.status);
  assert.equal(r1.totalViolations, r2.totalViolations);
  assert.deepEqual(r1.violations.map(v => v.code), r2.violations.map(v => v.code));
});

// ---------------------------------------------------------------------------
// DOMAIN 1: CHARACTER_STATE violations
// ---------------------------------------------------------------------------

test("checkContinuity: BLOCKING violation — deceased character reappears", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  // Kill Kael in EP_001
  state = advanceState(state, makeRecord("EP_001", {
    characterUpdates: [{ characterId: "CHAR_KAEL", characterName: "Kael", isDeceased: true }],
  }));

  // EP_002: Kael appears again
  const spec = makeSpec({
    shots: [{ id: "SH_001", characterIds: ["CHAR_KAEL"], visual: "Kael stands tall" }],
  });

  const report = checkContinuity(spec, state);
  assert.equal(report.status, "BLOCKED");
  assert.ok(report.blockingViolations >= 1);
  const v = report.violations.find(x => x.code === "CHAR_DECEASED_REAPPEARANCE");
  assert.ok(v, "CHAR_DECEASED_REAPPEARANCE violation expected");
  assert.ok(v!.affectedIds.includes("CHAR_KAEL"));
  assert.equal(v!.severity, "BLOCKING");
});

test("checkContinuity: REVIEW violation — character appears healed without condition resolved", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  // Injure Kael in EP_001
  state = advanceState(state, makeRecord("EP_001", {
    characterUpdates: [{ characterId: "CHAR_KAEL", characterName: "Kael", addConditions: ["right arm injured"] }],
  }));

  // EP_002: Kael appears healthy without resolving the injury
  const spec = makeSpec({
    shots: [{ id: "SH_001", characterIds: ["CHAR_KAEL"], visual: "Kael stands healed and healthy" }],
  });

  const report = checkContinuity(spec, state);
  assert.ok(report.status === "NEEDS_REVIEW" || report.status === "BLOCKED");
  const v = report.violations.find(x => x.code === "CHAR_CONDITION_UNRESOLVED");
  assert.ok(v, "CHAR_CONDITION_UNRESOLVED expected");
  assert.equal(v!.severity, "REVIEW");
});

test("checkContinuity: BLOCKING — character uses lost ability", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    characterUpdates: [{
      characterId: "CHAR_KAEL",
      characterName: "Kael",
      addConditions: ["cannot use magic"],
    }],
  }));

  const spec = makeSpec({
    shots: [{ id: "SH_001", characterIds: ["CHAR_KAEL"], visual: "Kael casts a powerful magic spell" }],
  });

  const report = checkContinuity(spec, state);
  assert.ok(report.blockingViolations >= 1);
  const v = report.violations.find(x => x.code === "CHAR_ABILITY_VIOLATION");
  assert.ok(v, "CHAR_ABILITY_VIOLATION expected");
  assert.equal(v!.severity, "BLOCKING");
});

test("checkContinuity: BLOCKING — character holds object belonging to another", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    objectUpdates: [{
      objectId: "OBJ_SWORD",
      objectName: "iron sword",
      currentHolderId: "CHAR_MIRA",
      isDestroyed: false,
      isLost: false,
    }],
  }));

  const spec = makeSpec({
    shots: [{
      id: "SH_001",
      characterIds: ["CHAR_KAEL"],
      visual: "Kael holds the iron sword triumphantly",
    }],
  });

  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "CHAR_POSSESSION_CONTRADICTION");
  assert.ok(v, "CHAR_POSSESSION_CONTRADICTION expected");
  assert.equal(v!.severity, "BLOCKING");
  assert.ok(v!.affectedIds.includes("CHAR_KAEL"));
  assert.ok(v!.affectedIds.includes("OBJ_SWORD"));
});

// ---------------------------------------------------------------------------
// DOMAIN 2: OBJECTS violations
// ---------------------------------------------------------------------------

test("checkContinuity: BLOCKING — destroyed object referenced in shot", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    objectUpdates: [{
      objectId: "OBJ_AMULET",
      objectName: "golden amulet",
      isDestroyed: true,
      isLost: false,
    }],
  }));

  const spec = makeSpec({
    shots: [{
      id: "SH_001",
      characterIds: [],
      visual: "The golden amulet glows on the altar",
    }],
  });

  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "OBJ_DESTROYED_REAPPEARANCE");
  assert.ok(v, "OBJ_DESTROYED_REAPPEARANCE expected");
  assert.equal(v!.severity, "BLOCKING");
  assert.equal(v!.domain, "OBJECTS");
});

test("checkContinuity: REVIEW — lost object referenced in shot", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    objectUpdates: [{
      objectId: "OBJ_MAP",
      objectName: "ancient map",
      isDestroyed: false,
      isLost: true,
    }],
  }));

  const spec = makeSpec({
    shots: [{
      id: "SH_001",
      characterIds: [],
      narration: "Kael searches for the ancient map",
    }],
  });

  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "OBJ_LOST_REFERENCE");
  assert.ok(v, "OBJ_LOST_REFERENCE expected");
  assert.equal(v!.severity, "REVIEW");
});

test("checkContinuity: no violation — destroyed object not referenced in episode", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    objectUpdates: [{
      objectId: "OBJ_AMULET",
      objectName: "golden amulet",
      isDestroyed: true,
      isLost: false,
    }],
  }));

  // Spec doesn't mention the amulet at all
  const spec = makeSpec({
    shots: [{ id: "SH_001", characterIds: ["CHAR_KAEL"], visual: "Kael walks through the forest" }],
  });

  const report = checkContinuity(spec, state);
  assert.equal(report.status, "CLEAR");
});

// ---------------------------------------------------------------------------
// DOMAIN 3: RELATIONSHIPS violations
// ---------------------------------------------------------------------------

test("checkContinuity: BLOCKING — characters unknown to each other are shown interacting", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    relationshipUpdates: [{
      characterAId: "CHAR_KAEL",
      characterBId: "CHAR_MIRA",
      newStatus: "unknown to each other",
    }],
  }));

  const spec = makeSpec({
    shots: [{
      id: "SH_001",
      characterIds: ["CHAR_KAEL", "CHAR_MIRA"],
      visual: "Kael and Mira stand together",
      dialogue: "Mira says: You have found me at last.",
    }],
  });

  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "REL_UNKNOWN_PARTY_INTERACTION");
  assert.ok(v, "REL_UNKNOWN_PARTY_INTERACTION expected");
  assert.equal(v!.severity, "BLOCKING");
  assert.ok(v!.affectedIds.includes("CHAR_KAEL"));
  assert.ok(v!.affectedIds.includes("CHAR_MIRA"));
});

test("checkContinuity: REVIEW — enemies shown cooperating", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    relationshipUpdates: [{
      characterAId: "CHAR_KAEL",
      characterBId: "CHAR_MIRA",
      newStatus: "enemies",
    }],
  }));

  const spec = makeSpec({
    shots: [{
      id: "SH_001",
      characterIds: ["CHAR_KAEL", "CHAR_MIRA"],
      visual: "Kael and Mira fight side by side against the beast",
    }],
  });

  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "REL_ENEMY_COOPERATION");
  assert.ok(v, "REL_ENEMY_COOPERATION expected");
  assert.equal(v!.severity, "REVIEW");
});

test("checkContinuity: no relationship violation when characters share a scene without interaction markers", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    relationshipUpdates: [{
      characterAId: "CHAR_KAEL",
      characterBId: "CHAR_MIRA",
      newStatus: "unknown to each other",
    }],
  }));

  // Both in shot but no recognition/dialogue
  const spec = makeSpec({
    shots: [{
      id: "SH_001",
      characterIds: ["CHAR_KAEL", "CHAR_MIRA"],
      visual: "Two figures stand at opposite ends of the ruins",
    }],
  });

  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "REL_UNKNOWN_PARTY_INTERACTION");
  assert.ok(!v, "No REL_UNKNOWN_PARTY_INTERACTION expected when no recognition markers");
});

// ---------------------------------------------------------------------------
// DOMAIN 4: WORLD_RULES violations
// ---------------------------------------------------------------------------

test("checkContinuity: REVIEW — shot contradicts established world rule", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    newWorldRules: [{
      ruleId: "RULE_MAGIC_FIRE",
      description: "Fire magic requires a blood sacrifice to activate",
    }],
  }));

  const spec = makeSpec({
    shots: [{
      id: "SH_001",
      characterIds: ["CHAR_KAEL"],
      visual: "Kael uses fire without sacrifice",
    }],
  });

  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "WORLD_RULE_VIOLATION");
  assert.ok(v, "WORLD_RULE_VIOLATION expected");
  assert.equal(v!.severity, "REVIEW");
  assert.equal(v!.domain, "WORLD_RULES");
});

test("checkContinuity: no world rule violation when rule is already overridden", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    newWorldRules: [{
      ruleId: "RULE_MAGIC_FIRE",
      description: "Fire magic requires blood sacrifice",
    }],
  }));

  state = advanceState(state, makeRecord("EP_002", {
    overriddenWorldRules: [{ ruleId: "RULE_MAGIC_FIRE" }],
  }));

  const spec = makeSpec({
    shots: [{
      id: "SH_001",
      characterIds: ["CHAR_KAEL"],
      visual: "Kael uses fire without sacrifice",
    }],
  });

  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "WORLD_RULE_VIOLATION");
  assert.ok(!v, "No WORLD_RULE_VIOLATION — rule was overridden");
});

// ---------------------------------------------------------------------------
// DOMAIN 5: TIMELINE violations
// ---------------------------------------------------------------------------

test("checkContinuity: REVIEW — unexplained time jump in scene time field", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    timelineEvents: [{
      eventId: "EVT_001",
      description: "Kael finds the symbol",
      tags: ["kael", "symbol"],
    }],
  }));

  // Next episode has a scene set "50 years ago" with no flashback marker
  const spec = makeSpec({ sceneTime: "50 years ago" });
  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "TIMELINE_UNEXPLAINED_JUMP");
  assert.ok(v, "TIMELINE_UNEXPLAINED_JUMP expected");
  assert.equal(v!.severity, "REVIEW");
});

test("checkContinuity: no timeline violation when scene is marked as flashback", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    timelineEvents: [{ eventId: "EVT_001", description: "Kael finds the symbol", tags: [] }],
  }));

  const spec = makeSpec({ sceneTime: "50 years ago, flashback" });
  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "TIMELINE_UNEXPLAINED_JUMP");
  assert.ok(!v, "No violation when flashback is explicit");
});

test("checkContinuity: no timeline violation when there is no prior history", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible); // no events yet
  const spec = makeSpec({ sceneTime: "50 years ago" });
  const report = checkContinuity(spec, state);
  const v = report.violations.find(x => x.code === "TIMELINE_UNEXPLAINED_JUMP");
  assert.ok(!v, "No violation on first episode — no prior timeline to contradict");
});

// ---------------------------------------------------------------------------
// advanceState tests
// ---------------------------------------------------------------------------

test("advanceState: increments stateVersion", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  assert.equal(state.stateVersion, 0);
  const next = advanceState(state, makeRecord("EP_001"));
  assert.equal(next.stateVersion, 1);
  const next2 = advanceState(next, makeRecord("EP_002"));
  assert.equal(next2.stateVersion, 2);
});

test("advanceState: does NOT mutate input state (immutability)", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  const stateCopy = JSON.parse(JSON.stringify(state));

  advanceState(state, makeRecord("EP_001", {
    characterUpdates: [{
      characterId: "CHAR_KAEL",
      characterName: "Kael",
      isDeceased: true,
    }],
  }));

  // Original state must be unchanged
  assert.deepEqual(state, stateCopy);
});

test("advanceState: marks character as deceased", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  const next = advanceState(state, makeRecord("EP_001", {
    characterUpdates: [{ characterId: "CHAR_KAEL", characterName: "Kael", isDeceased: true }],
  }));
  const kael = next.characters.find(c => c.characterId === "CHAR_KAEL");
  assert.ok(kael?.isDeceased);
  assert.equal(kael?.lastSeenEpisodeId, "EP_001");
});

test("advanceState: adds and removes character conditions", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    characterUpdates: [{
      characterId: "CHAR_KAEL",
      characterName: "Kael",
      addConditions: ["right arm injured", "cannot use magic"],
    }],
  }));

  let kael = state.characters.find(c => c.characterId === "CHAR_KAEL")!;
  assert.ok(kael.activeConditions.includes("right arm injured"));
  assert.ok(kael.activeConditions.includes("cannot use magic"));

  state = advanceState(state, makeRecord("EP_002", {
    characterUpdates: [{
      characterId: "CHAR_KAEL",
      characterName: "Kael",
      removeConditions: ["right arm injured"],
    }],
  }));

  kael = state.characters.find(c => c.characterId === "CHAR_KAEL")!;
  assert.ok(!kael.activeConditions.includes("right arm injured"), "injury should be resolved");
  assert.ok(kael.activeConditions.includes("cannot use magic"), "magic condition should remain");
});

test("advanceState: manages character possessions", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    characterUpdates: [{
      characterId: "CHAR_KAEL",
      characterName: "Kael",
      addPossessions: ["iron sword", "map of the ruins"],
    }],
  }));

  let kael = state.characters.find(c => c.characterId === "CHAR_KAEL")!;
  assert.ok(kael.currentPossessions.includes("iron sword"));

  state = advanceState(state, makeRecord("EP_002", {
    characterUpdates: [{
      characterId: "CHAR_KAEL",
      characterName: "Kael",
      removePossessions: ["iron sword"],
    }],
  }));

  kael = state.characters.find(c => c.characterId === "CHAR_KAEL")!;
  assert.ok(!kael.currentPossessions.includes("iron sword"), "sword removed");
  assert.ok(kael.currentPossessions.includes("map of the ruins"), "map remains");
});

test("advanceState: introduces a new character not in SeriesBible", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    characterUpdates: [{
      characterId: "CHAR_ELDER",
      characterName: "The Elder",
      currentLocation: "Temple Summit",
    }],
  }));

  const elder = state.characters.find(c => c.characterId === "CHAR_ELDER");
  assert.ok(elder, "New character should be added");
  assert.equal(elder!.characterName, "The Elder");
  assert.equal(elder!.currentLocation, "Temple Summit");
});

test("advanceState: tracks objects — creation, transfer, destruction", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  // Create sword held by Kael
  state = advanceState(state, makeRecord("EP_001", {
    objectUpdates: [{
      objectId: "OBJ_SWORD",
      objectName: "iron sword",
      currentHolderId: "CHAR_KAEL",
      isDestroyed: false,
      isLost: false,
    }],
  }));
  let obj = state.objects.find(o => o.objectId === "OBJ_SWORD")!;
  assert.equal(obj.currentHolderId, "CHAR_KAEL");

  // Transfer to Mira
  state = advanceState(state, makeRecord("EP_002", {
    objectUpdates: [{
      objectId: "OBJ_SWORD",
      objectName: "iron sword",
      currentHolderId: "CHAR_MIRA",
    }],
  }));
  obj = state.objects.find(o => o.objectId === "OBJ_SWORD")!;
  assert.equal(obj.currentHolderId, "CHAR_MIRA");

  // Destroy it
  state = advanceState(state, makeRecord("EP_003", {
    objectUpdates: [{
      objectId: "OBJ_SWORD",
      objectName: "iron sword",
      isDestroyed: true,
    }],
  }));
  obj = state.objects.find(o => o.objectId === "OBJ_SWORD")!;
  assert.equal(obj.isDestroyed, true);
  assert.equal(obj.lastChangedEpisodeId, "EP_003");
});

test("advanceState: records and advances world rules", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    newWorldRules: [{
      ruleId: "RULE_PORTAL",
      description: "Portals only open at dawn",
    }],
  }));
  assert.equal(state.worldRules.length, 1);
  assert.equal(state.worldRules[0].ruleId, "RULE_PORTAL");
  assert.equal(state.worldRules[0].isOverridden, false);

  state = advanceState(state, makeRecord("EP_002", {
    overriddenWorldRules: [{ ruleId: "RULE_PORTAL" }],
  }));
  assert.equal(state.worldRules[0].isOverridden, true);
  assert.equal(state.worldRules[0].overriddenEpisodeId, "EP_002");
});

test("advanceState: records timeline events", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    timelineEvents: [
      { eventId: "EVT_001", description: "Kael discovers the symbol", tags: ["kael", "symbol"] },
      { eventId: "EVT_002", shotId: "SH_004", description: "The temple collapses", tags: ["temple"] },
    ],
  }));

  assert.equal(state.timeline.length, 2);
  assert.equal(state.timeline[0].episodeId, "EP_001");
  assert.equal(state.timeline[1].shotId, "SH_004");
  assert.ok(state.timeline[0].tags.includes("kael"));
});

test("advanceState: records relationship changes with history", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  state = advanceState(state, makeRecord("EP_001", {
    relationshipUpdates: [{
      characterAId: "CHAR_KAEL",
      characterBId: "CHAR_MIRA",
      newStatus: "allies",
      addHistoryEvent: "Fought together against the shadow beast",
    }],
  }));

  assert.equal(state.relationships.length, 1);
  assert.equal(state.relationships[0].status, "allies");
  assert.ok(state.relationships[0].history.includes("Fought together against the shadow beast"));
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test("checkContinuity: throws for null spec", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  assert.throws(
    () => checkContinuity(null as any, state),
    /EpisodeSpec/
  );
});

test("checkContinuity: throws for null state", () => {
  const spec = makeSpec();
  assert.throws(
    () => checkContinuity(spec, null as any),
    /ContinuityState/
  );
});

test("checkContinuity: throws when seriesId mismatches", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  const spec = makeSpec({ seriesId: "DIFFERENT_SERIES" });
  assert.throws(
    () => checkContinuity(spec, state),
    /seriesId/
  );
});

test("advanceState: throws for null state", () => {
  assert.throws(
    () => advanceState(null as any, makeRecord("EP_001")),
    /ContinuityState/
  );
});

test("advanceState: throws for null record", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  assert.throws(
    () => advanceState(state, null as any),
    /ApprovedEpisodeRecord/
  );
});

test("advanceState: throws when record seriesId mismatches state", () => {
  const bible = makeBible();
  const state = createInitialState("SERIES_01", bible);
  const record = { ...makeRecord("EP_001"), seriesId: "WRONG_SERIES" };
  assert.throws(
    () => advanceState(state, record),
    /seriesId/
  );
});

// ---------------------------------------------------------------------------
// Multi-episode integration scenario
// ---------------------------------------------------------------------------

test("integration: multi-episode state advancement then violation check", () => {
  const bible = makeBible();
  let state = createInitialState("SERIES_01", bible);

  // EP_001: Establish sword, injure Kael, establish relationship
  state = advanceState(state, makeRecord("EP_001", {
    characterUpdates: [{
      characterId: "CHAR_KAEL",
      characterName: "Kael",
      addConditions: ["right arm injured"],
      addPossessions: ["iron sword"],
      addKnownFacts: ["knows the symbol location"],
    }],
    objectUpdates: [{
      objectId: "OBJ_SWORD",
      objectName: "iron sword",
      currentHolderId: "CHAR_KAEL",
      isDestroyed: false,
      isLost: false,
    }],
    relationshipUpdates: [{
      characterAId: "CHAR_KAEL",
      characterBId: "CHAR_MIRA",
      newStatus: "enemies",
    }],
    timelineEvents: [{
      eventId: "EVT_001",
      description: "Kael injures his arm in battle",
      tags: ["kael", "injury"],
    }],
  }));

  // EP_002: Destroy the sword
  state = advanceState(state, makeRecord("EP_002", {
    objectUpdates: [{ objectId: "OBJ_SWORD", objectName: "iron sword", isDestroyed: true }],
  }));

  assert.equal(state.stateVersion, 2);

  // Now check EP_003 which attempts to re-reference the sword (destroyed) and kill Kael (already alive)
  const ep003 = makeSpec({
    episodeId: "EP_003",
    shots: [{
      id: "SH_001",
      characterIds: ["CHAR_KAEL"],
      visual: "Kael wields the iron sword in the sunlight",
    }],
  });

  const report = checkContinuity(ep003, state);
  assert.equal(report.status, "BLOCKED"); // destroyed sword reappears
  assert.ok(report.blockingViolations >= 1);
  const swordViolation = report.violations.find(v => v.code === "OBJ_DESTROYED_REAPPEARANCE");
  assert.ok(swordViolation);
});
