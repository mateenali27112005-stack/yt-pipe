/**
 * V0.8 — The Continuity Engine: Type Contracts
 *
 * The Continuity Engine compares a new EpisodeSpec against the SeriesBible
 * and the approved episode history before expensive media generation begins.
 *
 * Design rules:
 *   - All types are PURE — no I/O, no side effects, no external dependencies.
 *   - ContinuityState is the single source of truth for what the fictional
 *     universe currently believes to be true after each approved episode.
 *   - Violations are either BLOCKING (hard errors that prevent production)
 *     or REVIEW (soft flags that require founder acknowledgement but can proceed).
 *   - The continuity checker is deterministic: same inputs → same violations.
 *
 * Five continuity domains (per the Master Execution Plan):
 *   1. CHARACTER_STATE  — age, injuries, clothing, abilities, knowledge, location
 *   2. OBJECTS          — ownership, possession, destruction, loss, reappearance
 *   3. RELATIONSHIPS    — alliances, betrayals, knowledge, tension
 *   4. WORLD_RULES      — magic, technology, geography, politics, constraints
 *   5. TIMELINE         — events, time jumps, previous facts, unresolved mysteries
 */

// ---------------------------------------------------------------------------
// Continuity State — the fictional universe's current authoritative record
// ---------------------------------------------------------------------------

export interface CharacterContinuityState {
  /** Character ID from SeriesBible. */
  characterId: string;
  characterName: string;
  /** Free-text fields that can change between episodes. */
  currentLocation?: string;
  clothingDescription?: string;
  /** Injuries, abilities, knowledge — append-only list of facts. */
  activeConditions: string[];          // e.g. ["right arm injured", "cannot use magic"]
  currentPossessions: string[];        // e.g. ["iron sword", "map of the ruins"]
  knownFacts: string[];                // e.g. ["knows the symbol location", "betrayed by Mira"]
  /** Set to true when the character has died (makes any re-appearance a violation). */
  isDeceased: boolean;
  /** Episode + shot where the character last appeared. */
  lastSeenEpisodeId?: string;
  lastSeenShotId?: string;
}

export interface ObjectContinuityState {
  /** A tracked object within the fictional universe. */
  objectId: string;
  objectName: string;
  /** Who currently holds/controls this object. */
  currentHolderId?: string;           // characterId or "WORLD" / "DESTROYED"
  /** If destroyed, it should never reappear without explanation. */
  isDestroyed: boolean;
  isLost: boolean;
  /** Episode where the object last changed state. */
  lastChangedEpisodeId?: string;
}

export interface RelationshipState {
  characterAId: string;
  characterBId: string;
  /** Current relationship descriptor. */
  status: string;                     // e.g. "allied", "enemies", "unknown to each other"
  /** Significant events that changed this relationship. */
  history: string[];
  lastChangedEpisodeId?: string;
}

export interface WorldRuleFact {
  ruleId: string;
  description: string;
  /** True if this rule has been canonically broken/overridden in an episode. */
  isOverridden: boolean;
  establishedEpisodeId: string;
  overriddenEpisodeId?: string;
}

export interface TimelineEvent {
  eventId: string;
  episodeId: string;
  shotId?: string;
  description: string;
  /** ISO 8601 in-universe time (optional, relative or absolute). */
  inUniverseTime?: string;
  /** Tags for cross-referencing (e.g. ["sword_destroyed", "kael_injured"]). */
  tags: string[];
}

/**
 * The full continuity state of the fictional universe.
 * Updated deterministically after each approved episode.
 */
export interface ContinuityState {
  schemaVersion: "0.1";
  seriesId: string;
  /** Monotonically increasing version, incremented after each approved episode. */
  stateVersion: number;
  /** The episode ID whose approval last updated this state. */
  lastApprovedEpisodeId?: string;
  updatedAt: string;
  characters: CharacterContinuityState[];
  objects: ObjectContinuityState[];
  relationships: RelationshipState[];
  worldRules: WorldRuleFact[];
  timeline: TimelineEvent[];
}

// ---------------------------------------------------------------------------
// Approved Episode Record — immutable proof of what an approved episode declared
// ---------------------------------------------------------------------------

/**
 * A record of what a single approved episode asserted about the universe.
 * Used as input to advance the ContinuityState.
 */
export interface ApprovedEpisodeRecord {
  schemaVersion: "0.1";
  episodeId: string;
  episodeTitle: string;
  seriesId: string;
  specVersion: number;
  approvedAt: string;
  /** Continuity deltas declared in this episode. */
  deltas: EpisodeContinuityDelta;
}

/**
 * What changed in the fictional universe during this episode.
 * All deltas are intentional writer decisions — they update ContinuityState.
 */
export interface EpisodeContinuityDelta {
  /** Characters whose state changes in this episode. */
  characterUpdates?: Array<{
    characterId: string;
    characterName: string;
    currentLocation?: string;
    clothingDescription?: string;
    addConditions?: string[];
    removeConditions?: string[];
    addPossessions?: string[];
    removePossessions?: string[];
    addKnownFacts?: string[];
    isDeceased?: boolean;
    lastSeenShotId?: string;
  }>;

  /** Objects whose state changes in this episode. */
  objectUpdates?: Array<{
    objectId: string;
    objectName: string;
    currentHolderId?: string;
    isDestroyed?: boolean;
    isLost?: boolean;
  }>;

  /** Relationship changes. */
  relationshipUpdates?: Array<{
    characterAId: string;
    characterBId: string;
    newStatus: string;
    addHistoryEvent?: string;
  }>;

  /** New world rules established in this episode. */
  newWorldRules?: Array<{
    ruleId: string;
    description: string;
  }>;

  /** World rules overridden/broken in this episode. */
  overriddenWorldRules?: Array<{
    ruleId: string;
  }>;

  /** Significant timeline events that occurred. */
  timelineEvents?: Array<{
    eventId: string;
    shotId?: string;
    description: string;
    inUniverseTime?: string;
    tags?: string[];
  }>;
}

// ---------------------------------------------------------------------------
// Continuity Violation
// ---------------------------------------------------------------------------

/** Which continuity domain the violation belongs to. */
export type ContinuityDomain =
  | "CHARACTER_STATE"
  | "OBJECTS"
  | "RELATIONSHIPS"
  | "WORLD_RULES"
  | "TIMELINE";

/**
 * Severity of a continuity violation.
 *
 * BLOCKING — must be fixed before production continues. The contradiction
 *   would produce a visible, embarrassing error in the final episode.
 *
 * REVIEW   — founder must acknowledge before production continues, but
 *   may be an intentional creative decision (e.g. a retcon or flashback).
 */
export type ViolationSeverity = "BLOCKING" | "REVIEW";

export interface ContinuityViolation {
  /** Short machine-readable code for the violation type. */
  code: string;
  domain: ContinuityDomain;
  severity: ViolationSeverity;
  /** Human-readable explanation suitable for a founder review log. */
  message: string;
  /** Shot in the new episode where the violation appears. */
  shotId?: string;
  sceneId?: string;
  /** IDs of affected characters, objects, or rules. */
  affectedIds: string[];
  /** What the continuity state currently believes (the established fact). */
  establishedFact?: string;
  /** What the new episode is claiming (the contradiction). */
  newClaim?: string;
  /** Episode where the established fact was last confirmed. */
  establishedInEpisodeId?: string;
}

// ---------------------------------------------------------------------------
// Continuity Check Report
// ---------------------------------------------------------------------------

export interface ContinuityCheckReport {
  schemaVersion: "0.1";
  episodeId: string;
  specVersion: number;
  checkedAt: string;
  /**
   * CLEAR     — no violations found; production may proceed.
   * NEEDS_REVIEW — only REVIEW-severity violations; founder must acknowledge.
   * BLOCKED   — one or more BLOCKING violations; production must not proceed.
   */
  status: "CLEAR" | "NEEDS_REVIEW" | "BLOCKED";
  totalViolations: number;
  blockingViolations: number;
  reviewViolations: number;
  violations: ContinuityViolation[];
}
