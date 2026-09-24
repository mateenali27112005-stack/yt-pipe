import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildImagePrompt, generateAndPublishVisualAsset, generateVisualAsset, type ImageProvider } from "../src/image.ts";
import { fakeImageProvider } from "../src/providers/fake-image-provider.ts";
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
function plan() { return createVisualPlan(spec, timeline, { profile, generatedAt: new Date("2026-09-25T12:00:00.000Z") }); }

test("creates a generated image version without mutating the planned V0.3 version", async () => {
  const temp = mkdtempSync(join(tmpdir(), "visual-image-"));
  try {
    const { visualSpec, manifest } = plan();
    const result = await generateVisualAsset(visualSpec, manifest, "VAS_SH_001_001", { outputDirectory: join(temp, "assets"), provider: fakeImageProvider, generatedAt: new Date("2026-09-26T12:00:00.000Z") });
    const asset = result.assets[0];
    assert.equal(result.manifestRevision, 2);
    assert.equal(asset.activeVersionId, "VAS_SH_001_001_v2");
    assert.deepEqual(asset.versions.map(version => [version.id, version.lifecycle, version.supersedesVersionId]), [["VAS_SH_001_001_v1", "PLANNED", undefined], ["VAS_SH_001_001_v2", "GENERATED", "VAS_SH_001_001_v1"]]);
    assert.equal(asset.versions[1].provider?.model, "deterministic-fake-v1");
    assert.match(asset.versions[1].provider?.promptHash ?? "", /^[a-f0-9]{64}$/);
    assert.match(asset.versions[1].output?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.deepEqual(readFileSync(join(temp, "assets", "VAS_SH_001_001_v2.png")), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
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
    await assert.rejects(generateVisualAsset(mismatched, manifest, "VAS_SH_001_001", { outputDirectory: temp, provider: fakeImageProvider }), /does not match/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("removes a generated PNG when manifest publication fails", async () => {
  const temp = mkdtempSync(join(tmpdir(), "visual-image-"));
  try {
    const { visualSpec, manifest } = plan();
    const assetDirectory = join(temp, "assets");
    const manifestPath = join(temp, "asset_manifest.json");
    const originalManifest = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, originalManifest);
    await assert.rejects(
      generateAndPublishVisualAsset(visualSpec, manifest, "VAS_SH_001_001", {
        outputDirectory: assetDirectory,
        manifestPath,
        provider: fakeImageProvider,
        publishManifest: async () => { throw new Error("manifest storage unavailable"); }
      }),
      /manifest storage unavailable/
    );
    assert.throws(() => readFileSync(join(assetDirectory, "VAS_SH_001_001_v2.png")));
    assert.equal(readFileSync(manifestPath, "utf8"), originalManifest);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("CLI can generate an image with the reusable fake provider", () => {
  const temp = mkdtempSync(join(tmpdir(), "visual-image-cli-"));
  try {
    const { visualSpec, manifest } = plan();
    const visualSpecPath = join(temp, "shot_visual_spec.json");
    const manifestPath = join(temp, "asset_manifest.json");
    writeFileSync(visualSpecPath, JSON.stringify(visualSpec));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/image-cli.ts", visualSpecPath, manifestPath, "VAS_SH_001_001", "--provider", "fake", "--overwrite-manifest"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const updatedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(updatedManifest.assets[0].activeVersionId, "VAS_SH_001_001_v2");
    assert.equal(updatedManifest.assets[0].versions[1].provider.name, "deterministic-fake-image");
    assert.ok(readFileSync(join(temp, "assets", "VAS_SH_001_001_v2.png")).byteLength > 0);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("CLI requires an explicit known image provider", () => {
  const temp = mkdtempSync(join(tmpdir(), "visual-image-cli-"));
  try {
    const { visualSpec, manifest } = plan();
    const visualSpecPath = join(temp, "shot_visual_spec.json");
    const manifestPath = join(temp, "asset_manifest.json");
    writeFileSync(visualSpecPath, JSON.stringify(visualSpec));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const missingProvider = spawnSync(process.execPath, ["--experimental-strip-types", "src/image-cli.ts", visualSpecPath, manifestPath, "VAS_SH_001_001", "--overwrite-manifest"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(missingProvider.status, 2);
    assert.match(missingProvider.stderr, /requires --provider/);
    const unknownProvider = spawnSync(process.execPath, ["--experimental-strip-types", "src/image-cli.ts", visualSpecPath, manifestPath, "VAS_SH_001_001", "--provider", "unknown", "--overwrite-manifest"], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(unknownProvider.status, 2);
    assert.match(unknownProvider.stderr, /Unknown image provider/);
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
