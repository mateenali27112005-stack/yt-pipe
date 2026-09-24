import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildImagePrompt, generateVisualAsset, type ImageProvider } from "../src/image.ts";
import { createVisualPlan } from "../src/visual.ts";
import type { EpisodeSpec, RealizedTimeline, VisualProfile } from "../src/types.ts";

const profile: VisualProfile = { styleReference: "cinematic manhwa", defaultLighting: "motivated lighting", defaultMood: "dramatic", defaultCameraIntent: "slow hold" };
const spec: EpisodeSpec = {
  schemaVersion: "0.1", specVersion: 1, lifecycle: "VALIDATED", episode: { id: "EP_001", title: "Awakening", seriesId: "SERIES_A" },
  registry: { characters: [{ id: "CHAR_KAEL", name: "Kael" }], locations: [{ id: "LOC_TEMPLE", name: "temple" }] },
  scenes: [{ id: "SC_001", order: 1, title: "Temple", location: { id: "LOC_TEMPLE", name: "temple" }, purpose: "Discovery.", shots: [{ id: "SH_001_001", order: 1, purpose: "Reveal the symbol.", characterIds: ["CHAR_KAEL"], visual: "Extreme close-up of an ominous glowing symbol in blue light.", plannedTiming: { min: 3, target: 4, max: 5 } }] }],
  provenance: { parser: "episode-production-agent", parserVersion: "0.1.0" }
};
const timeline: RealizedTimeline = { schemaVersion: "0.1", timelineVersion: 1, episodeId: "EP_001", sourceSpecVersion: 1, generatedAt: "2026-09-25T12:00:00.000Z", totalDurationSeconds: 2, segments: [{ id: "SEG_1", shotId: "SH_001_001", role: "narration", text: "A symbol.", startSeconds: 0, endSeconds: 2, durationSeconds: 2, audioAssetId: "AST_1" }] };
const fakeProvider: ImageProvider = { name: "test-image-provider", async generate({ prompt }) { return { bytes: new Uint8Array([137, 80, 78, 71]), model: "test-model", revisedPrompt: `${prompt}\noptimized` }; } };

function plan() { return createVisualPlan(spec, timeline, { profile, generatedAt: new Date("2026-09-25T12:00:00.000Z") }); }

test("creates a generated image version without mutating the planned V0.3 version", async () => {
  const temp = mkdtempSync(join(tmpdir(), "visual-image-"));
  try {
    const { visualSpec, manifest } = plan();
    const result = await generateVisualAsset(visualSpec, manifest, "VAS_SH_001_001", { outputDirectory: join(temp, "assets"), provider: fakeProvider, generatedAt: new Date("2026-09-26T12:00:00.000Z") });
    const asset = result.assets[0];
    assert.equal(result.manifestRevision, 2);
    assert.equal(asset.activeVersionId, "VAS_SH_001_001_v2");
    assert.deepEqual(asset.versions.map(version => [version.id, version.lifecycle, version.supersedesVersionId]), [["VAS_SH_001_001_v1", "PLANNED", undefined], ["VAS_SH_001_001_v2", "GENERATED", "VAS_SH_001_001_v1"]]);
    assert.equal(asset.versions[1].provider?.model, "test-model");
    assert.match(asset.versions[1].provider?.promptHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(asset.versions[1].output?.sha256, "0f4636c78f65d3639ece5a064b5ae753e3408614a14fb18ab4d7540d2c248543");
    assert.deepEqual(readFileSync(join(temp, "assets", "VAS_SH_001_001_v2.png")), Buffer.from([137, 80, 78, 71]));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("builds a structured provider prompt from the V0.3 visual contract", () => {
  const { visualSpec } = plan();
  const prompt = buildImagePrompt(visualSpec.shots[0]);
  assert.match(prompt, /Asset type: cinematic motion-comic shot/);
  assert.match(prompt, /Framing: extreme close-up/);
  assert.match(prompt, /no text, captions, logos, or watermarks/);
});

test("rejects mismatched visual-spec and manifest provenance before provider use", async () => {
  const temp = mkdtempSync(join(tmpdir(), "visual-image-"));
  try {
    const { visualSpec, manifest } = plan();
    const mismatched = structuredClone(visualSpec);
    mismatched.visualSpecVersion = 2;
    await assert.rejects(generateVisualAsset(mismatched, manifest, "VAS_SH_001_001", { outputDirectory: temp, provider: fakeProvider }), /does not match/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("does not publish image files when a provider fails", async () => {
  const temp = mkdtempSync(join(tmpdir(), "visual-image-"));
  try {
    const { visualSpec, manifest } = plan();
    const failing: ImageProvider = { name: "failing", async generate() { throw new Error("provider outage"); } };
    await assert.rejects(generateVisualAsset(visualSpec, manifest, "VAS_SH_001_001", { outputDirectory: temp, provider: failing }), /provider outage/);
    assert.throws(() => readFileSync(join(temp, "VAS_SH_001_001_v2.png")));
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
