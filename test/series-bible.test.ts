import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateVisualAsset, type ImageProvider } from "../src/image.ts";
import { assertSeriesBible, assertSeriesBibleMatchesEpisode } from "../src/series-bible.ts";
import { createVisualPlan } from "../src/visual.ts";
import type { EpisodeSpec, RealizedTimeline, SeriesBible, VisualProfile } from "../src/types.ts";

const profile: VisualProfile = { styleReference: "Manhwa cinematic", defaultLighting: "motivated lighting", defaultMood: "dramatic", defaultCameraIntent: "slow hold" };
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const spec: EpisodeSpec = {
  schemaVersion: "0.1", specVersion: 1, lifecycle: "VALIDATED", episode: { id: "EP_001", title: "Awakening", seriesId: "SERIES_A" },
  registry: { characters: [{ id: "CHAR_001", name: "Kael" }], locations: [{ id: "LOC_001", name: "Ruined Temple" }] },
  scenes: [{ id: "SC_001", order: 1, title: "Temple", location: { id: "LOC_001", name: "Ruined Temple" }, purpose: "Discovery.", shots: [{ id: "SH_001_001", order: 1, purpose: "Kael touches the symbol.", characterIds: ["CHAR_001"], visual: "Close-up of Kael touching a glowing symbol.", plannedTiming: { min: 3, target: 4, max: 5 } }] }],
  provenance: { parser: "episode-production-agent", parserVersion: "0.1.0" }
};
const timeline: RealizedTimeline = { schemaVersion: "0.1", timelineVersion: 1, episodeId: "EP_001", sourceSpecVersion: 1, generatedAt: "2026-09-25T12:00:00.000Z", totalDurationSeconds: 2, segments: [{ id: "SEG_1", shotId: "SH_001_001", role: "narration", text: "The symbol glows.", startSeconds: 0, endSeconds: 2, durationSeconds: 2, audioAssetId: "AST_1" }] };
const bible: SeriesBible = {
  schemaVersion: "0.1", bibleVersion: 1, seriesId: "SERIES_A", generatedAt: "2026-09-25T12:00:00.000Z",
  characters: [{ id: "CHAR_001", name: "Kael", appearance: { hair: "short black hair", eyes: "amber eyes", build: "lean athletic build", clothing: "dark academy uniform" }, personalityVisualCues: ["guarded posture"], referenceAssets: [{ id: "REF_CHAR_001_v1", version: 1, path: "references/kael-v1.png" }, { id: "REF_CHAR_001_v2", version: 2, path: "references/kael-v2.png" }], activeReferenceAssetId: "REF_CHAR_001_v2" }],
  locations: [{ id: "LOC_001", name: "Ruined Temple", visualDescription: "weathered obsidian pillars and blue rune light", referenceAssets: [{ id: "REF_LOC_001_v1", version: 1, path: "references/temple-v1.png" }], activeReferenceAssetId: "REF_LOC_001_v1" }],
  visualStyles: [{ id: "STYLE_001", name: "Manhwa cinematic", promptGuidance: "clean manhwa linework with cinematic lighting", negativePrompt: "photorealism" }]
};

test("enriches every V0.5 shot with deterministic canonical continuity", () => {
  const first = createVisualPlan(spec, timeline, { profile, seriesBible: bible, generatedAt: new Date("2026-09-25T12:00:00.000Z") });
  const second = createVisualPlan(spec, timeline, { profile, seriesBible: bible, generatedAt: new Date("2026-09-25T12:00:00.000Z") });
  assert.deepEqual(first, second);
  assert.equal(first.visualSpec.sourceSeriesBibleVersion, 1);
  assert.equal(first.manifest.sourceSeriesBibleVersion, 1);
  const continuity = first.visualSpec.shots[0].continuity!;
  assert.equal(continuity.characterReferences[0].id, "CHAR_001");
  assert.equal(continuity.characterReferences[0].activeReferenceAsset?.id, "REF_CHAR_001_v2");
  assert.equal(continuity.locationReference.activeReferenceAsset?.id, "REF_LOC_001_v1");
  assert.equal(continuity.styleReference.id, "STYLE_001");
  assert.match(continuity.sourceHash, /^[a-f0-9]{64}$/);
});

test("rejects unresolved Bible identities and EpisodeSpec registry mismatches", () => {
  const missingReference = structuredClone(bible);
  missingReference.characters[0].activeReferenceAssetId = "REF_UNKNOWN";
  assert.throws(() => assertSeriesBible(missingReference), /unresolved active reference/);
  const renamedCharacter = structuredClone(bible);
  renamedCharacter.characters[0].name = "Kale";
  assert.throws(() => assertSeriesBibleMatchesEpisode(spec, renamedCharacter), /does not resolve character/);
  const missingStyle = structuredClone(bible);
  missingStyle.visualStyles = [];
  assert.throws(() => createVisualPlan(spec, timeline, { profile, seriesBible: missingStyle }), /does not resolve visual style/);
});

test("passes resolved active reference assets through the image provider boundary", async () => {
  const temp = mkdtempSync(join(tmpdir(), "series-bible-image-"));
  try {
    const { visualSpec, manifest } = createVisualPlan(spec, timeline, { profile, seriesBible: bible, generatedAt: new Date("2026-09-25T12:00:00.000Z") });
    let receivedReferenceIds: string[] | undefined;
    const provider: ImageProvider = { name: "capture", async generate(input) { receivedReferenceIds = input.referenceAssets?.map(asset => asset.id); return { bytes: new Uint8Array([137, 80, 78, 71]), model: "capture-v1" }; } };
    const next = await generateVisualAsset(visualSpec, manifest, "VAS_SH_001_001", { outputDirectory: temp, provider, seriesBible: bible, generatedAt: new Date("2026-09-26T12:00:00.000Z") });
    assert.deepEqual(receivedReferenceIds, ["REF_CHAR_001_v2", "REF_LOC_001_v1"]);
    assert.equal(next.assets[0].versions[1].provider?.model, "capture-v1");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("rejects stale Bible content before image generation", async () => {
  const temp = mkdtempSync(join(tmpdir(), "series-bible-image-"));
  try {
    const { visualSpec, manifest } = createVisualPlan(spec, timeline, { profile, seriesBible: bible, generatedAt: new Date("2026-09-25T12:00:00.000Z") });
    const staleBible = structuredClone(bible);
    staleBible.characters[0].appearance.hair = "long silver hair";
    const provider: ImageProvider = { name: "should-not-run", async generate() { throw new Error("provider should not run"); } };
    await assert.rejects(generateVisualAsset(visualSpec, manifest, "VAS_SH_001_001", { outputDirectory: temp, provider, seriesBible: staleBible }), /does not match the ShotVisualSpec continuity snapshot/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("keeps content hashes stable across metadata-only Bible revisions while preserving revision provenance", async () => {
  const bibleV2 = structuredClone(bible);
  bibleV2.bibleVersion = 2;
  bibleV2.generatedAt = "2026-09-26T12:00:00.000Z";
  const v1Plan = createVisualPlan(spec, timeline, { profile, seriesBible: bible, generatedAt: new Date("2026-09-25T12:00:00.000Z") });
  const v2Plan = createVisualPlan(spec, timeline, { profile, seriesBible: bibleV2, generatedAt: new Date("2026-09-26T12:00:00.000Z") });
  assert.equal(v1Plan.visualSpec.shots[0].continuity?.sourceHash, v2Plan.visualSpec.shots[0].continuity?.sourceHash);
  assert.equal(v1Plan.visualSpec.sourceSeriesBibleVersion, 1);
  assert.equal(v2Plan.visualSpec.sourceSeriesBibleVersion, 2);
  assert.equal(v1Plan.manifest.sourceSeriesBibleVersion, 1);
  assert.equal(v2Plan.manifest.sourceSeriesBibleVersion, 2);
  const provider: ImageProvider = { name: "should-not-run", async generate() { throw new Error("provider should not run"); } };
  await assert.rejects(generateVisualAsset(v1Plan.visualSpec, v1Plan.manifest, "VAS_SH_001_001", { outputDirectory: join(tmpdir(), "series-bible-version-check"), provider, seriesBible: bibleV2 }), /SeriesBible version does not match/);
});

test("V0.5 CLI plans and generates with the same SeriesBible revision", () => {
  const temp = mkdtempSync(join(tmpdir(), "series-bible-cli-"));
  try {
    const episodePath = join(temp, "episode.json");
    const timelinePath = join(temp, "timeline.json");
    const profilePath = join(temp, "profile.json");
    const biblePath = join(temp, "series_bible.json");
    const outputPath = join(temp, "visual");
    writeFileSync(episodePath, JSON.stringify(spec));
    writeFileSync(timelinePath, JSON.stringify(timeline));
    writeFileSync(profilePath, JSON.stringify(profile));
    writeFileSync(biblePath, JSON.stringify(bible));
    const planResult = spawnSync(process.execPath, ["--experimental-strip-types", "src/visual-cli.ts", episodePath, timelinePath, outputPath, "--visual-profile", profilePath, "--series-bible", biblePath], { cwd: root, encoding: "utf8" });
    assert.equal(planResult.status, 0, planResult.stderr);
    const imageResult = spawnSync(process.execPath, ["--experimental-strip-types", "src/image-cli.ts", join(outputPath, "shot_visual_spec.json"), join(outputPath, "asset_manifest.json"), "VAS_SH_001_001", "--provider", "fake", "--series-bible", biblePath, "--overwrite-manifest"], { cwd: root, encoding: "utf8" });
    assert.equal(imageResult.status, 0, imageResult.stderr);
    const manifest = JSON.parse(readFileSync(join(outputPath, "asset_manifest.json"), "utf8"));
    assert.equal(manifest.sourceSeriesBibleVersion, 1);
    assert.equal(manifest.assets[0].activeVersionId, "VAS_SH_001_001_v2");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
