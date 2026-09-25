import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFinalCompositionSpec } from "../src/postproduction.ts";
import type { AudioAssetManifest, MotionCompositionPlan, RealizedTimeline, AssetManifest } from "../src/types.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const timeline: RealizedTimeline = { schemaVersion: "0.1", timelineVersion: 1, episodeId: "EP_001", sourceSpecVersion: 1, generatedAt: "2026-09-25T00:00:00.000Z", totalDurationSeconds: 3, segments: [{ id: "SEG_1", shotId: "SH_001_001", role: "narration", text: "The symbol woke.", startSeconds: 0, endSeconds: 2, durationSeconds: 2, audioAssetId: "AST_1" }, { id: "SEG_2", shotId: "SH_001_001", role: "dialogue", speaker: "Kael", text: "What is this?", startSeconds: 2, endSeconds: 3, durationSeconds: 1, audioAssetId: "AST_2" }] };
const audio: AudioAssetManifest = { schemaVersion: "0.1", episodeId: "EP_001", sourceSpecVersion: 1, generatedAt: "2026-09-25T00:00:00.000Z", provider: "macos-say", assets: [{ id: "AST_1", segmentId: "SEG_1", shotId: "SH_001_001", role: "narration", voice: "Narrator", path: "assets/1.aiff", format: "aiff", durationSeconds: 2 }, { id: "AST_2", segmentId: "SEG_2", shotId: "SH_001_001", role: "dialogue", voice: "Kael", path: "assets/2.aiff", format: "aiff", durationSeconds: 1 }] };

const assetManifest = {
  schemaVersion: "0.1",
  manifestRevision: 2,
  episodeId: "EP_001",
  sourceSpecVersion: 1,
  sourceVisualSpecVersion: 1,
  generatedAt: "2026-09-25T00:00:00.000Z",
  assets: [{
    id: "VAS_SH_001_001",
    shotId: "SH_001_001",
    activeReferenceAsset: {
      versionId: "VAS_SH_001_001_v2",
      path: "assets/1.png",
      sha256: "a".repeat(64),
      generatedAt: "2026-09-25T00:00:00.000Z"
    }
  }]
};

const motion: MotionCompositionPlan = { schemaVersion: "0.1", motionPlanVersion: 1, episodeId: "EP_001", sourceSpecVersion: 1, sourceTimelineVersion: 1, sourceVisualSpecVersion: 1, sourceAssetManifestRevision: 2, generatedAt: "2026-09-25T00:00:00.000Z", canvas: { width: 1920, height: 1080, frameRate: 24 }, shots: [{ id: "MCP_SH_001_001", sceneId: "SC_001", shotId: "SH_001_001", visualAsset: { assetId: "VAS_SH_001_001", assetVersionId: "VAS_SH_001_001_v2", path: "assets/1.png", sha256: "a".repeat(64) }, timing: { startSeconds: 0, endSeconds: 3, durationSeconds: 3 }, camera: { intent: "slow push-in", keyframes: [{ offset: 0, scale: 1, x: .5, y: .5 }, { offset: 1, scale: 1.08, x: .5, y: .5 }] }, sourceHash: "b".repeat(64) }] };

test("assembles deterministic narration, music, SFX, and captions on the realized timeline", () => {
  const first = createFinalCompositionSpec(timeline, audio, motion, assetManifest, { generatedAt: new Date("2026-09-26T00:00:00.000Z") });
  const second = createFinalCompositionSpec(timeline, audio, motion, assetManifest, { generatedAt: new Date("2026-09-26T00:00:00.000Z") });
  assert.deepEqual(first, second);
  assert.equal(first.durationSeconds, 3);
  assert.deepEqual(first.visualComposition.canvas, motion.canvas);
  assert.deepEqual(first.visualComposition.shots, motion.shots);
  assert.equal(first.visualComposition.shots[0].visualAsset.assetVersionId, "VAS_SH_001_001_v2");
  assert.deepEqual(first.visualComposition.shots[0].camera.keyframes, motion.shots[0].camera.keyframes);
  assert.deepEqual(first.narrationDialogueTracks.map(track => track.audioAssetId), ["AST_1", "AST_2"]);
  assert.deepEqual(first.captions.map(caption => caption.text), ["The symbol woke.", "What is this?"]);
  assert.equal(first.musicCues[0].lifecycle, "PLANNED");
  assert.equal(first.musicCues[0].id, "MUS_EP_001");
  assert.equal(first.sfxCues[0].description, "subtle cinematic motion swell");
  assert.match(first.sourceHash, /^[a-f0-9]{64}$/);
});

test("derives music cue identity from the actual episode ID", () => {
  const episodeTwoTimeline = structuredClone(timeline); episodeTwoTimeline.episodeId = "EP_002";
  const episodeTwoAudio = structuredClone(audio); episodeTwoAudio.episodeId = "EP_002";
  const episodeTwoMotion = structuredClone(motion); episodeTwoMotion.episodeId = "EP_002";
  assert.equal(createFinalCompositionSpec(timeline, audio, motion, assetManifest, { generatedAt: new Date("2026-09-26T00:00:00.000Z") }).musicCues[0].id, "MUS_EP_001");
  assert.equal(createFinalCompositionSpec(episodeTwoTimeline, episodeTwoAudio, episodeTwoMotion, assetManifest, { generatedAt: new Date("2026-09-26T00:00:00.000Z") }).musicCues[0].id, "MUS_EP_002");
});

test("rejects mismatched audio and incomplete motion coverage", () => {
  const wrongAudio = structuredClone(audio); wrongAudio.assets[0].segmentId = "SEG_UNKNOWN";
  assert.throws(() => createFinalCompositionSpec(timeline, wrongAudio, motion, assetManifest), /unresolved audio segment/);
  const missingMotion = structuredClone(motion); missingMotion.shots = [];
  assert.throws(() => createFinalCompositionSpec(timeline, audio, missingMotion, assetManifest), /does not contain shot/);
});

test("rejects malformed referenced audio asset metadata", () => {
  const emptyPath = structuredClone(audio); emptyPath.assets[0].path = "";
  assert.throws(() => createFinalCompositionSpec(timeline, emptyPath, motion, assetManifest), /malformed asset/);
  const invalidDuration = structuredClone(audio); invalidDuration.assets[0].durationSeconds = -1;
  assert.throws(() => createFinalCompositionSpec(timeline, invalidDuration, motion, assetManifest), /malformed asset/);
  const missingVoice = structuredClone(audio); missingVoice.assets[0].voice = "";
  assert.throws(() => createFinalCompositionSpec(timeline, missingVoice, motion, assetManifest), /malformed asset/);
  const missingFormat = structuredClone(audio); missingFormat.assets[0].format = "" as "aiff";
  assert.throws(() => createFinalCompositionSpec(timeline, missingFormat, motion, assetManifest), /format must be aiff|malformed asset/);
});

test("rejects malformed, duplicate, and out-of-contract motion composition shots", () => {
  const malformedAsset = structuredClone(motion); malformedAsset.shots[0].visualAsset.sha256 = "not-a-hash";
  assert.throws(() => createFinalCompositionSpec(timeline, audio, malformedAsset, assetManifest), /invalid visual composition shot/);
  const invalidTiming = structuredClone(motion); invalidTiming.shots[0].timing = { startSeconds: 0, endSeconds: 4, durationSeconds: 4 };
  assert.throws(() => createFinalCompositionSpec(timeline, audio, invalidTiming, assetManifest), /does not match the RealizedTimeline timing/);
  const duplicate = structuredClone(motion); duplicate.shots.push(structuredClone(duplicate.shots[0]));
  duplicate.shots[1].id = "MCP_SH_001_002"; // bypass duplicate record ID check
  assert.throws(() => createFinalCompositionSpec(timeline, audio, duplicate, assetManifest), /duplicate shot/);
  const invalidCamera = structuredClone(motion); invalidCamera.shots[0].camera.keyframes[1].offset = 0;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, invalidCamera, assetManifest), /invalid visual composition shot/);
  const invalidTransition = structuredClone(motion); invalidTransition.shots[0].transitionIn = { type: "CROSSFADE", atSeconds: 1, durationSeconds: 0 };
  assert.throws(() => createFinalCompositionSpec(timeline, audio, invalidTransition, assetManifest), /invalid visual composition shot/);
  const longCrossfade = structuredClone(motion); longCrossfade.shots[0].transitionIn = { type: "CROSSFADE", atSeconds: 0, durationSeconds: 0.8 };
  assert.throws(() => createFinalCompositionSpec(timeline, audio, longCrossfade, assetManifest), /invalid visual composition shot/);
});

test("postproduction CLI publishes a protected final composition specification", () => {
  const temp = mkdtempSync(join(tmpdir(), "postproduction-"));
  try {
    const paths = ["timeline.json", "audio.json", "motion.json", "asset.json"].map(name => join(temp, name));
    [timeline, audio, motion, assetManifest].forEach((value, index) => writeFileSync(paths[index], JSON.stringify(value)));
    const output = join(temp, "composition");
    const args = ["--experimental-strip-types", "src/postproduction-cli.ts", ...paths, output];
    const first = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /POSTPRODUCTION_PLAN_COMPLETE: 2 audio tracks, 2 captions/);
    assert.equal(JSON.parse(readFileSync(join(output, "final_composition_spec.json"), "utf8")).compositionVersion, 1);
    const second = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(second.status, 2); assert.match(second.stderr, /Refusing to write into existing/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});


test("rejects zero-duration and overlapping timeline segments", () => {
  const zeroDuration = structuredClone(timeline);
  zeroDuration.segments[1].endSeconds = zeroDuration.segments[1].startSeconds;
  zeroDuration.segments[1].durationSeconds = 0;
  assert.throws(() => createFinalCompositionSpec(zeroDuration, audio, motion, assetManifest), /invalid timing/);

  const overlap = structuredClone(timeline);
  overlap.segments[1].startSeconds = 1;
  overlap.segments[1].endSeconds = 3;
  overlap.segments[1].durationSeconds = 2;
  assert.throws(() => createFinalCompositionSpec(overlap, audio, motion, assetManifest), /overlapping/);
});

test("rejects timeline segments not in chronological order", () => {
  const outOfOrder = structuredClone(timeline);
  const temp = outOfOrder.segments[0];
  outOfOrder.segments[0] = outOfOrder.segments[1];
  outOfOrder.segments[1] = temp;
  assert.throws(() => createFinalCompositionSpec(outOfOrder, audio, motion, assetManifest), /overlapping or not in chronological order/);
});

test("rejects duplicate timeline segment and audio asset IDs", () => {
  const duplicateSegment = structuredClone(timeline);
  duplicateSegment.segments[1].id = duplicateSegment.segments[0].id;
  assert.throws(() => createFinalCompositionSpec(duplicateSegment, audio, motion, assetManifest), /duplicate segment IDs/);

  const duplicateAudio = structuredClone(timeline);
  duplicateAudio.segments[1].audioAssetId = duplicateAudio.segments[0].audioAssetId;
  assert.throws(() => createFinalCompositionSpec(duplicateAudio, audio, motion, assetManifest), /duplicate audio asset IDs/);
});

test("rejects timeline where final endSeconds does not match totalDurationSeconds", () => {
  const mismatch = structuredClone(timeline);
  mismatch.totalDurationSeconds = 4;
  assert.throws(() => createFinalCompositionSpec(mismatch, audio, motion, assetManifest), /does not match totalDurationSeconds/);
});

test("rejects duplicate asset and segment IDs in audio manifest", () => {
  const duplicateAsset = structuredClone(audio);
  duplicateAsset.assets[1].id = duplicateAsset.assets[0].id;
  assert.throws(() => createFinalCompositionSpec(timeline, duplicateAsset, motion, assetManifest), /duplicate asset IDs/);

  const duplicateSegment = structuredClone(audio);
  duplicateSegment.assets[1].segmentId = duplicateSegment.assets[0].segmentId;
  assert.throws(() => createFinalCompositionSpec(timeline, duplicateSegment, motion, assetManifest), /duplicate segment IDs/);
});

test("rejects invalid audio format and provider", () => {
  const badFormat = structuredClone(audio);
  (badFormat.assets[0] as any).format = "mp3";
  assert.throws(() => createFinalCompositionSpec(timeline, badFormat, motion, assetManifest), /format must be aiff/);

  const badProvider = structuredClone(audio);
  (badProvider as any).provider = "aws-polly";
  assert.throws(() => createFinalCompositionSpec(timeline, badProvider, motion, assetManifest), /provider must be macos-say/);
});

test("rejects invalid motion provenance versions", () => {
  const badVisual = structuredClone(motion);
  badVisual.sourceVisualSpecVersion = -1;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, badVisual, assetManifest), /sourceVisualSpecVersion must be positive integer/);

  const badAsset = structuredClone(motion);
  badAsset.sourceAssetManifestRevision = 0;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, badAsset, assetManifest), /sourceAssetManifestRevision must be positive integer/);
});

test("rejects invalid captions", () => {
  const emptyText = structuredClone(timeline);
  emptyText.segments[0].text = "   ";
  assert.throws(() => createFinalCompositionSpec(emptyText, audio, motion, assetManifest), /text cannot be empty/);

  const badRole = structuredClone(timeline);
  (badRole.segments[0] as any).role = "unknown";
  assert.throws(() => createFinalCompositionSpec(badRole, audio, motion, assetManifest), /role must be narration or dialogue/);

  const missingSpeaker = structuredClone(timeline);
  missingSpeaker.segments[1].role = "dialogue";
  missingSpeaker.segments[1].speaker = "";
  assert.throws(() => createFinalCompositionSpec(missingSpeaker, audio, motion, assetManifest), /dialogue segment must have a speaker/);
});

test("rejects invalid motion canvas", () => {
  const missingCanvas = structuredClone(motion);
  (missingCanvas as any).canvas = undefined;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, missingCanvas, assetManifest), /canvas is missing or invalid/);

  const zeroWidth = structuredClone(motion);
  zeroWidth.canvas.width = 0;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, zeroWidth, assetManifest), /dimensions and frameRate must be valid/);

  const negativeHeight = structuredClone(motion);
  negativeHeight.canvas.height = -1080;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, negativeHeight, assetManifest), /dimensions and frameRate must be valid/);

  const zeroFrameRate = structuredClone(motion);
  zeroFrameRate.canvas.frameRate = 0;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, zeroFrameRate, assetManifest), /dimensions and frameRate must be valid/);

  const negativeFrameRate = structuredClone(motion);
  negativeFrameRate.canvas.frameRate = -24;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, negativeFrameRate, assetManifest), /dimensions and frameRate must be valid/);

  const nonFiniteFrameRate = structuredClone(motion);
  nonFiniteFrameRate.canvas.frameRate = Infinity;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, nonFiniteFrameRate, assetManifest), /dimensions and frameRate must be valid/);
});

test("accepts valid fractional frameRate", () => {
  const fractional = structuredClone(motion);
  fractional.canvas.frameRate = 23.976;
  const spec = createFinalCompositionSpec(timeline, audio, fractional, assetManifest);
  assert.equal(spec.visualComposition.canvas.frameRate, 23.976);
});

test("postproduction CLI rejects unknown flags and missing values", () => {
  const temp = mkdtempSync(join(tmpdir(), "postproduction-cli-bad-"));
  try {
    const paths = ["timeline.json", "audio.json", "motion.json", "asset.json"].map(name => join(temp, name));
    [timeline, audio, motion, assetManifest].forEach((value, index) => writeFileSync(paths[index], JSON.stringify(value)));
    const output = join(temp, "composition");

    let res = spawnSync(process.execPath, ["--experimental-strip-types", "src/postproduction-cli.ts", ...paths, output, "--banana"], { cwd: root, encoding: "utf8" });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Unknown flag: --banana/);

    res = spawnSync(process.execPath, ["--experimental-strip-types", "src/postproduction-cli.ts", ...paths, output, "--composition-version"], { cwd: root, encoding: "utf8" });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Missing value for --composition-version/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});


test("rejects empty timeline", () => {
  const empty = structuredClone(timeline);
  empty.segments = [];
  assert.throws(() => createFinalCompositionSpec(empty, audio, motion, assetManifest), /at least one segment/);
});

test("rejects audio asset duration mismatch with timeline segment duration", () => {
  const mismatch = structuredClone(audio);
  mismatch.assets[0].durationSeconds = 7;
  assert.throws(() => createFinalCompositionSpec(timeline, mismatch, motion, assetManifest), /duration must match/);
});

test("rejects duplicate motion record IDs", () => {
  const duplicate = structuredClone(motion);
  const shot2 = structuredClone(duplicate.shots[0]);
  shot2.shotId = "SH_001_002"; // different shotId
  shot2.timing = { startSeconds: 3, endSeconds: 5, durationSeconds: 2 }; // valid timing so it doesn't fail early
  // same id though: MCP_SH_001_001
  
  // Create a timeline that has this second shot so it passes the timing check
  const myTimeline = structuredClone(timeline);
  myTimeline.segments.push({ id: "SEG_3", shotId: "SH_001_002", role: "narration", text: "Test", startSeconds: 3, endSeconds: 5, durationSeconds: 2, audioAssetId: "AST_3" });
  myTimeline.totalDurationSeconds = 5;
  
  const myAudio = structuredClone(audio);
  myAudio.assets.push({ id: "AST_3", segmentId: "SEG_3", shotId: "SH_001_002", role: "narration", voice: "Narrator", path: "assets/3.aiff", format: "aiff", durationSeconds: 2 });
  
  duplicate.shots.push(shot2);
  
  assert.throws(() => createFinalCompositionSpec(myTimeline, myAudio, duplicate, assetManifest), /duplicate record/);
});

test("preserves visual-spec and SeriesBible provenance", () => {
  const spec = createFinalCompositionSpec(timeline, audio, motion, assetManifest);
  assert.equal(spec.sourceVisualSpecVersion, 1);
  
  const motionWithBible = structuredClone(motion);
  motionWithBible.sourceSeriesBibleVersion = 2;
  const specWithBible = createFinalCompositionSpec(timeline, audio, motionWithBible, assetManifest);
  assert.equal(specWithBible.sourceSeriesBibleVersion, 2);
});


test("CLI correctly parses flags and values", () => {
  const temp = mkdtempSync(join(tmpdir(), "postproduction-cli-test-"));
  const cli = join(root, "src/postproduction-cli.ts");
  try {
    writeFileSync(join(temp, "timeline.json"), JSON.stringify(timeline));
    writeFileSync(join(temp, "audio.json"), JSON.stringify(audio));
    writeFileSync(join(temp, "motion.json"), JSON.stringify(motion));
    writeFileSync(join(temp, "asset.json"), JSON.stringify(assetManifest));
    
    // Test --composition-version 2
    let res = spawnSync(process.execPath, ["--experimental-strip-types", cli, join(temp, "timeline.json"), join(temp, "audio.json"), join(temp, "motion.json"), join(temp, "asset.json"), join(temp, "spec1"), "--composition-version", "2"], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    let spec = JSON.parse(readFileSync(join(temp, "spec1", "final_composition_spec.json"), "utf8"));
    assert.equal(spec.compositionVersion, 2);

    // Test --music-style "dark cinematic"
    res = spawnSync(process.execPath, ["--experimental-strip-types", cli, join(temp, "timeline.json"), join(temp, "audio.json"), join(temp, "motion.json"), join(temp, "asset.json"), join(temp, "spec2"), "--music-style", "dark cinematic"], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    spec = JSON.parse(readFileSync(join(temp, "spec2", "final_composition_spec.json"), "utf8"));
    assert.equal(spec.musicCues[0].style, "dark cinematic");

    // Test both
    res = spawnSync(process.execPath, ["--experimental-strip-types", cli, join(temp, "timeline.json"), join(temp, "audio.json"), join(temp, "motion.json"), join(temp, "asset.json"), join(temp, "spec3"), "--composition-version", "3", "--music-style", "epic score"], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    spec = JSON.parse(readFileSync(join(temp, "spec3", "final_composition_spec.json"), "utf8"));
    assert.equal(spec.compositionVersion, 3);
    assert.equal(spec.musicCues[0].style, "epic score");
    
    // Test overwrite + valued flags
    res = spawnSync(process.execPath, ["--experimental-strip-types", cli, join(temp, "timeline.json"), join(temp, "audio.json"), join(temp, "motion.json"), join(temp, "asset.json"), join(temp, "spec3"), "--composition-version", "4", "--overwrite"], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    spec = JSON.parse(readFileSync(join(temp, "spec3", "final_composition_spec.json"), "utf8"));
    assert.equal(spec.compositionVersion, 4);

  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
