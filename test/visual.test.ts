import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertAssetManifest, createVisualPlan, regenerateVisualAsset } from "../src/visual.ts";
import type { EpisodeSpec, RealizedTimeline, VisualProfile } from "../src/types.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const profile: VisualProfile = { styleReference: "cinematic manhwa", defaultLighting: "motivated lighting", defaultMood: "dramatic", defaultCameraIntent: "slow hold" };
const spec: EpisodeSpec = {
  schemaVersion: "0.1", specVersion: 1, lifecycle: "VALIDATED", episode: { id: "EP_001", title: "The Awakening", seriesId: "SERIES_A" },
  registry: { characters: [{ id: "CHAR_KAEL", name: "Kael" }], locations: [{ id: "LOC_TEMPLE", name: "ruined_temple" }] },
  scenes: [{ id: "SC_001", order: 1, title: "Temple", location: { id: "LOC_TEMPLE", name: "ruined_temple" }, purpose: "Discovery.", shots: [{ id: "SH_001_001", order: 1, purpose: "Reveal symbol.", characterIds: ["CHAR_KAEL"], visual: "Extreme close-up of an ominous glowing symbol in blue light.", plannedTiming: { min: 3, target: 4, max: 5 } }] }],
  provenance: { parser: "episode-production-agent", parserVersion: "0.1.0" }
};
const timeline: RealizedTimeline = { schemaVersion: "0.1", episodeId: "EP_001", sourceSpecVersion: 1, generatedAt: "2026-09-25T12:00:00.000Z", totalDurationSeconds: 3.75, segments: [{ id: "SEG_SH_001_001_NARRATION", shotId: "SH_001_001", role: "narration", text: "A symbol.", startSeconds: 0, endSeconds: 2.5, durationSeconds: 2.5, audioAssetId: "AST_1" }, { id: "SEG_SH_001_001_DIALOGUE", shotId: "SH_001_001", role: "dialogue", speaker: "Kael", text: "What is this?", startSeconds: 2.5, endSeconds: 3.75, durationSeconds: 1.25, audioAssetId: "AST_2" }] };

function plan() { return createVisualPlan(spec, timeline, { profile, generatedAt: new Date("2026-09-25T12:00:00.000Z") }); }

test("derives deterministic visual specs and one planned asset per shot", () => {
  const first = plan();
  const second = plan();
  assert.deepEqual(first, second);
  const shot = first.visualSpec.shots[0];
  assert.deepEqual([shot.id, shot.sceneId, shot.shotId, shot.characterIds, shot.locationId], ["VSP_SH_001_001", "SC_001", "SH_001_001", ["CHAR_KAEL"], "LOC_TEMPLE"]);
  assert.deepEqual(shot.realizedTiming, { startSeconds: 0, endSeconds: 3.75, durationSeconds: 3.75 });
  assert.equal(shot.framing, "extreme close-up");
  assert.equal(shot.cameraIntent, "slow push-in");
  assert.equal(first.manifest.assets[0].activeVersionId, "VAS_SH_001_001_v1");
});

test("regeneration preserves earlier asset versions and advances one active pointer", () => {
  const { manifest } = plan();
  const next = regenerateVisualAsset(manifest, "VAS_SH_001_001", new Date("2026-09-26T12:00:00.000Z"));
  const asset = next.assets[0];
  assert.equal(next.manifestRevision, 2);
  assert.equal(asset.activeVersionId, "VAS_SH_001_001_v2");
  assert.deepEqual(asset.versions.map(version => [version.id, version.supersedesVersionId]), [["VAS_SH_001_001_v1", undefined], ["VAS_SH_001_001_v2", "VAS_SH_001_001_v1"]]);
});

test("rejects invalid planning inputs and inconsistent timelines", () => {
  const draft = structuredClone(spec);
  draft.lifecycle = "DRAFT";
  assert.throws(() => createVisualPlan(draft, timeline, { profile }), /lifecycle VALIDATED/);
  const mismatched = structuredClone(timeline);
  mismatched.episodeId = "EP_999";
  assert.throws(() => createVisualPlan(spec, mismatched, { profile }), /does not match/);
  const badSegment = structuredClone(timeline);
  badSegment.segments[0].shotId = "SH_UNKNOWN";
  assert.throws(() => createVisualPlan(spec, badSegment, { profile }), /invalid or unresolved/);
  const unknownCharacter = structuredClone(spec);
  unknownCharacter.scenes[0].shots[0].characterIds = ["CHAR_UNKNOWN"];
  assert.throws(() => createVisualPlan(unknownCharacter, timeline, { profile }), /unresolved shot visual reference/);
  const unknownLocation = structuredClone(spec);
  unknownLocation.scenes[0].location.id = "LOC_UNKNOWN";
  assert.throws(() => createVisualPlan(unknownLocation, timeline, { profile }), /unresolved scene location/);
});

test("rejects malformed manifests and unknown regeneration targets", () => {
  const { manifest } = plan();
  const malformed = structuredClone(manifest);
  malformed.assets[0].activeVersionId = "VAS_SH_001_001_v9";
  assert.throws(() => assertAssetManifest(malformed), /exactly one active version/);
  assert.throws(() => regenerateVisualAsset(manifest, "VAS_UNKNOWN"), /does not exist/);
});

test("visual plan CLI writes contracts and rejects a repeated output directory", () => {
  const temp = mkdtempSync(join(tmpdir(), "visual-plan-"));
  try {
    const episodePath = join(temp, "episode.json");
    const timelinePath = join(temp, "timeline.json");
    const profilePath = join(temp, "profile.json");
    const outputPath = join(temp, "visual");
    writeFileSync(episodePath, JSON.stringify(spec));
    writeFileSync(timelinePath, JSON.stringify(timeline));
    writeFileSync(profilePath, JSON.stringify(profile));
    const args = ["--experimental-strip-types", "src/visual-cli.ts", episodePath, timelinePath, outputPath, "--visual-profile", profilePath];
    const first = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /VISUAL_PLAN_COMPLETE: 1 shot specs, 1 planned assets/);
    const second = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(second.status, 2);
    assert.match(second.stderr, /Refusing to write into existing/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
