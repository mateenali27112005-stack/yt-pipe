import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createMotionCompositionPlan } from "../src/motion.ts";
import type { AssetManifest, RealizedTimeline, ShotVisualSpec } from "../src/types.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const timeline: RealizedTimeline = {
  schemaVersion: "0.1", timelineVersion: 2, episodeId: "EP_001", sourceSpecVersion: 1, generatedAt: "2026-09-25T12:00:00.000Z", totalDurationSeconds: 8,
  segments: [
    { id: "SEG_1", shotId: "SH_001_001", role: "narration", text: "One.", startSeconds: 0, endSeconds: 3, durationSeconds: 3, audioAssetId: "AST_1" },
    { id: "SEG_2", shotId: "SH_001_002", role: "narration", text: "Two.", startSeconds: 3, endSeconds: 5, durationSeconds: 2, audioAssetId: "AST_2" },
    { id: "SEG_3", shotId: "SH_002_001", role: "narration", text: "Three.", startSeconds: 5, endSeconds: 8, durationSeconds: 3, audioAssetId: "AST_3" }
  ]
};
const visualSpec: ShotVisualSpec = {
  schemaVersion: "0.1", visualSpecVersion: 3, episodeId: "EP_001", sourceSpecVersion: 1, sourceTimelineVersion: 2, sourceSeriesBibleVersion: 4, generatedAt: "2026-09-25T12:00:00.000Z",
  shots: [
    shot("VSP_SH_001_001", "SC_001", "SH_001_001", "slow push-in"),
    shot("VSP_SH_001_002", "SC_001", "SH_001_002", "slow hold"),
    shot("VSP_SH_002_001", "SC_002", "SH_002_001", "slow establishing hold")
  ]
};
const manifest: AssetManifest = {
  schemaVersion: "0.1", manifestRevision: 7, episodeId: "EP_001", sourceSpecVersion: 1, sourceVisualSpecVersion: 3, sourceSeriesBibleVersion: 4, generatedAt: "2026-09-25T12:00:00.000Z",
  assets: visualSpec.shots.map((shot, index) => ({
    id: `VAS_${shot.shotId}`, shotId: shot.shotId, shotVisualSpecId: shot.id, activeVersionId: `VAS_${shot.shotId}_v2`,
    versions: [{ id: `VAS_${shot.shotId}_v1`, version: 1, lifecycle: "PLANNED" as const, createdAt: "2026-09-24T12:00:00.000Z" }, { id: `VAS_${shot.shotId}_v2`, version: 2, lifecycle: "GENERATED" as const, createdAt: "2026-09-25T12:00:00.000Z", supersedesVersionId: `VAS_${shot.shotId}_v1`, output: { path: `assets/shot-${index + 1}.png`, format: "png" as const, byteLength: 4, sha256: "a".repeat(64) }, provider: { name: "fake", model: "fake-v1", promptHash: "b".repeat(64) } }]
  }))
};

function shot(id: string, sceneId: string, shotId: string, cameraIntent: string): ShotVisualSpec["shots"][number] {
  return { id, sceneId, shotId, characterIds: [], locationId: "LOC_001", visualIntent: "A visual.", framing: "medium shot", action: "Reveal.", expression: "calm", lighting: "soft", mood: "dramatic", cameraIntent, styleReference: "cinematic manhwa", sourceHash: "c".repeat(64) };
}

test("derives deterministic camera, transition, timing, and asset-version composition", () => {
  const first = createMotionCompositionPlan(timeline, visualSpec, manifest, { generatedAt: new Date("2026-09-26T12:00:00.000Z") });
  const second = createMotionCompositionPlan(timeline, visualSpec, manifest, { generatedAt: new Date("2026-09-26T12:00:00.000Z") });
  assert.deepEqual(first, second);
  assert.deepEqual(first.canvas, { width: 1920, height: 1080, frameRate: 24 });
  assert.equal(first.sourceTimelineVersion, 2);
  assert.equal(first.sourceVisualSpecVersion, 3);
  assert.equal(first.sourceAssetManifestRevision, 7);
  assert.equal(first.sourceSeriesBibleVersion, 4);
  assert.deepEqual(first.shots[0].camera.keyframes, [{ offset: 0, scale: 1, x: 0.5, y: 0.5 }, { offset: 1, scale: 1.08, x: 0.5, y: 0.5 }]);
  assert.deepEqual(first.shots[1].transitionIn, { type: "CUT", atSeconds: 3, durationSeconds: 0 });
  assert.deepEqual(first.shots[2].transitionIn, { type: "CROSSFADE", atSeconds: 5, durationSeconds: 0.35 });
  assert.equal(first.shots[2].visualAsset.assetVersionId, "VAS_SH_002_001_v2");
  assert.match(first.shots[2].sourceHash, /^[a-f0-9]{64}$/);
});

test("refuses planned assets and mismatched provenance", () => {
  const planned = structuredClone(manifest);
  planned.assets[0].activeVersionId = "VAS_SH_001_001_v1";
  assert.throws(() => createMotionCompositionPlan(timeline, visualSpec, planned), /requires a GENERATED active visual asset/);
  const mismatched = structuredClone(manifest);
  mismatched.sourceVisualSpecVersion = 99;
  assert.throws(() => createMotionCompositionPlan(timeline, visualSpec, mismatched), /does not match the ShotVisualSpec provenance/);
  const missingTiming = structuredClone(timeline);
  missingTiming.segments = missingTiming.segments.slice(0, 2);
  assert.throws(() => createMotionCompositionPlan(missingTiming, visualSpec, manifest), /does not contain timing/);
});

test("motion plan CLI publishes atomically and protects existing output", () => {
  const temp = mkdtempSync(join(tmpdir(), "motion-plan-"));
  try {
    const timelinePath = join(temp, "timeline.json");
    const visualSpecPath = join(temp, "visual.json");
    const manifestPath = join(temp, "manifest.json");
    const outputPath = join(temp, "motion");
    writeFileSync(timelinePath, JSON.stringify(timeline));
    writeFileSync(visualSpecPath, JSON.stringify(visualSpec));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const args = ["--experimental-strip-types", "src/motion-cli.ts", timelinePath, visualSpecPath, manifestPath, outputPath, "--motion-plan-version", "2"];
    const first = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /MOTION_PLAN_COMPLETE: 3 composited shots/);
    const saved = JSON.parse(readFileSync(join(outputPath, "motion_composition_plan.json"), "utf8"));
    assert.equal(saved.motionPlanVersion, 2);
    const second = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(second.status, 2);
    assert.match(second.stderr, /Refusing to write into existing/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
