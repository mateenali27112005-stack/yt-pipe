import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createFinalCompositionSpec } from "../src/postproduction.ts";
import type { AudioAssetManifest, MotionCompositionPlan, RealizedTimeline } from "../src/types.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const timeline: RealizedTimeline = { schemaVersion: "0.1", timelineVersion: 1, episodeId: "EP_001", sourceSpecVersion: 1, generatedAt: "2026-09-25T00:00:00.000Z", totalDurationSeconds: 3, segments: [{ id: "SEG_1", shotId: "SH_001_001", role: "narration", text: "The symbol woke.", startSeconds: 0, endSeconds: 2, durationSeconds: 2, audioAssetId: "AST_1" }, { id: "SEG_2", shotId: "SH_001_001", role: "dialogue", speaker: "Kael", text: "What is this?", startSeconds: 2, endSeconds: 3, durationSeconds: 1, audioAssetId: "AST_2" }] };
const audio: AudioAssetManifest = { schemaVersion: "0.1", episodeId: "EP_001", sourceSpecVersion: 1, generatedAt: "2026-09-25T00:00:00.000Z", provider: "macos-say", assets: [{ id: "AST_1", segmentId: "SEG_1", shotId: "SH_001_001", role: "narration", voice: "Narrator", path: "assets/1.aiff", format: "aiff", durationSeconds: 2 }, { id: "AST_2", segmentId: "SEG_2", shotId: "SH_001_001", role: "dialogue", voice: "Kael", path: "assets/2.aiff", format: "aiff", durationSeconds: 1 }] };
const motion: MotionCompositionPlan = { schemaVersion: "0.1", motionPlanVersion: 1, episodeId: "EP_001", sourceSpecVersion: 1, sourceTimelineVersion: 1, sourceVisualSpecVersion: 1, sourceAssetManifestRevision: 2, generatedAt: "2026-09-25T00:00:00.000Z", canvas: { width: 1920, height: 1080, frameRate: 24 }, shots: [{ id: "MCP_SH_001_001", sceneId: "SC_001", shotId: "SH_001_001", visualAsset: { assetId: "VAS_SH_001_001", assetVersionId: "VAS_SH_001_001_v2", path: "assets/1.png", sha256: "a".repeat(64) }, timing: { startSeconds: 0, endSeconds: 3, durationSeconds: 3 }, camera: { intent: "slow push-in", keyframes: [{ offset: 0, scale: 1, x: .5, y: .5 }, { offset: 1, scale: 1.08, x: .5, y: .5 }] }, sourceHash: "b".repeat(64) }] };

test("assembles deterministic narration, music, SFX, and captions on the realized timeline", () => {
  const first = createFinalCompositionSpec(timeline, audio, motion, { generatedAt: new Date("2026-09-26T00:00:00.000Z") });
  const second = createFinalCompositionSpec(timeline, audio, motion, { generatedAt: new Date("2026-09-26T00:00:00.000Z") });
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
  assert.equal(createFinalCompositionSpec(timeline, audio, motion, { generatedAt: new Date("2026-09-26T00:00:00.000Z") }).musicCues[0].id, "MUS_EP_001");
  assert.equal(createFinalCompositionSpec(episodeTwoTimeline, episodeTwoAudio, episodeTwoMotion, { generatedAt: new Date("2026-09-26T00:00:00.000Z") }).musicCues[0].id, "MUS_EP_002");
});

test("rejects mismatched audio and incomplete motion coverage", () => {
  const wrongAudio = structuredClone(audio); wrongAudio.assets[0].segmentId = "SEG_UNKNOWN";
  assert.throws(() => createFinalCompositionSpec(timeline, wrongAudio, motion), /unresolved audio segment/);
  const missingMotion = structuredClone(motion); missingMotion.shots = [];
  assert.throws(() => createFinalCompositionSpec(timeline, audio, missingMotion), /does not contain shot/);
});

test("rejects malformed referenced audio asset metadata", () => {
  const emptyPath = structuredClone(audio); emptyPath.assets[0].path = "";
  assert.throws(() => createFinalCompositionSpec(timeline, emptyPath, motion), /unresolved audio segment/);
  const invalidDuration = structuredClone(audio); invalidDuration.assets[0].durationSeconds = -1;
  assert.throws(() => createFinalCompositionSpec(timeline, invalidDuration, motion), /unresolved audio segment/);
  const missingVoice = structuredClone(audio); missingVoice.assets[0].voice = "";
  assert.throws(() => createFinalCompositionSpec(timeline, missingVoice, motion), /unresolved audio segment/);
  const missingFormat = structuredClone(audio); missingFormat.assets[0].format = "" as "aiff";
  assert.throws(() => createFinalCompositionSpec(timeline, missingFormat, motion), /format must be aiff|unresolved audio segment/);
});

test("rejects malformed, duplicate, and out-of-contract motion composition shots", () => {
  const malformedAsset = structuredClone(motion); malformedAsset.shots[0].visualAsset.sha256 = "not-a-hash";
  assert.throws(() => createFinalCompositionSpec(timeline, audio, malformedAsset), /invalid visual composition shot/);
  const invalidTiming = structuredClone(motion); invalidTiming.shots[0].timing = { startSeconds: 0, endSeconds: 4, durationSeconds: 4 };
  assert.throws(() => createFinalCompositionSpec(timeline, audio, invalidTiming), /does not match the RealizedTimeline timing/);
  const duplicate = structuredClone(motion); duplicate.shots.push(structuredClone(duplicate.shots[0]));
  assert.throws(() => createFinalCompositionSpec(timeline, audio, duplicate), /duplicate shot/);
  const invalidCamera = structuredClone(motion); invalidCamera.shots[0].camera.keyframes[1].offset = 0;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, invalidCamera), /invalid visual composition shot/);
  const invalidTransition = structuredClone(motion); invalidTransition.shots[0].transitionIn = { type: "CROSSFADE", atSeconds: 1, durationSeconds: 0 };
  assert.throws(() => createFinalCompositionSpec(timeline, audio, invalidTransition), /invalid visual composition shot/);
  const longCrossfade = structuredClone(motion); longCrossfade.shots[0].transitionIn = { type: "CROSSFADE", atSeconds: 0, durationSeconds: 0.8 };
  assert.throws(() => createFinalCompositionSpec(timeline, audio, longCrossfade), /invalid visual composition shot/);
});

test("postproduction CLI publishes a protected final composition specification", () => {
  const temp = mkdtempSync(join(tmpdir(), "postproduction-"));
  try {
    const paths = ["timeline.json", "audio.json", "motion.json"].map(name => join(temp, name));
    [timeline, audio, motion].forEach((value, index) => writeFileSync(paths[index], JSON.stringify(value)));
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
  assert.throws(() => createFinalCompositionSpec(zeroDuration, audio, motion), /invalid timing/);

  const overlap = structuredClone(timeline);
  overlap.segments[1].startSeconds = 1;
  overlap.segments[1].endSeconds = 3;
  overlap.segments[1].durationSeconds = 2;
  assert.throws(() => createFinalCompositionSpec(overlap, audio, motion), /overlapping/);
});

test("rejects timeline segments not in chronological order", () => {
  const outOfOrder = structuredClone(timeline);
  const temp = outOfOrder.segments[0];
  outOfOrder.segments[0] = outOfOrder.segments[1];
  outOfOrder.segments[1] = temp;
  assert.throws(() => createFinalCompositionSpec(outOfOrder, audio, motion), /overlapping or not in chronological order/);
});

test("rejects duplicate timeline segment and audio asset IDs", () => {
  const duplicateSegment = structuredClone(timeline);
  duplicateSegment.segments[1].id = duplicateSegment.segments[0].id;
  assert.throws(() => createFinalCompositionSpec(duplicateSegment, audio, motion), /duplicate segment IDs/);

  const duplicateAudio = structuredClone(timeline);
  duplicateAudio.segments[1].audioAssetId = duplicateAudio.segments[0].audioAssetId;
  assert.throws(() => createFinalCompositionSpec(duplicateAudio, audio, motion), /duplicate audio asset IDs/);
});

test("rejects timeline where final endSeconds does not match totalDurationSeconds", () => {
  const mismatch = structuredClone(timeline);
  mismatch.totalDurationSeconds = 4;
  assert.throws(() => createFinalCompositionSpec(mismatch, audio, motion), /does not match totalDurationSeconds/);
});

test("rejects duplicate asset and segment IDs in audio manifest", () => {
  const duplicateAsset = structuredClone(audio);
  duplicateAsset.assets[1].id = duplicateAsset.assets[0].id;
  assert.throws(() => createFinalCompositionSpec(timeline, duplicateAsset, motion), /duplicate asset IDs/);

  const duplicateSegment = structuredClone(audio);
  duplicateSegment.assets[1].segmentId = duplicateSegment.assets[0].segmentId;
  assert.throws(() => createFinalCompositionSpec(timeline, duplicateSegment, motion), /duplicate segment IDs/);
});

test("rejects invalid audio format and provider", () => {
  const badFormat = structuredClone(audio);
  (badFormat.assets[0] as any).format = "mp3";
  assert.throws(() => createFinalCompositionSpec(timeline, badFormat, motion), /format must be aiff/);

  const badProvider = structuredClone(audio);
  (badProvider as any).provider = "aws-polly";
  assert.throws(() => createFinalCompositionSpec(timeline, badProvider, motion), /provider must be macos-say/);
});

test("rejects invalid motion provenance versions", () => {
  const badVisual = structuredClone(motion);
  badVisual.sourceVisualSpecVersion = -1;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, badVisual), /sourceVisualSpecVersion must be positive integer/);

  const badAsset = structuredClone(motion);
  badAsset.sourceAssetManifestRevision = 0;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, badAsset), /sourceAssetManifestRevision must be positive integer/);
});

test("rejects invalid captions", () => {
  const emptyText = structuredClone(timeline);
  emptyText.segments[0].text = "   ";
  assert.throws(() => createFinalCompositionSpec(emptyText, audio, motion), /text cannot be empty/);

  const badRole = structuredClone(timeline);
  (badRole.segments[0] as any).role = "unknown";
  assert.throws(() => createFinalCompositionSpec(badRole, audio, motion), /role must be narration or dialogue/);

  const missingSpeaker = structuredClone(timeline);
  missingSpeaker.segments[1].role = "dialogue";
  missingSpeaker.segments[1].speaker = "";
  assert.throws(() => createFinalCompositionSpec(missingSpeaker, audio, motion), /dialogue segment must have a speaker/);
});

test("rejects invalid motion canvas", () => {
  const missingCanvas = structuredClone(motion);
  (missingCanvas as any).canvas = undefined;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, missingCanvas), /canvas is missing or invalid/);

  const zeroWidth = structuredClone(motion);
  zeroWidth.canvas.width = 0;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, zeroWidth), /dimensions and frameRate must be positive finite/);

  const negativeHeight = structuredClone(motion);
  negativeHeight.canvas.height = -1080;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, negativeHeight), /dimensions and frameRate must be positive finite/);

  const zeroFrameRate = structuredClone(motion);
  zeroFrameRate.canvas.frameRate = 0;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, zeroFrameRate), /dimensions and frameRate must be positive finite/);

  const negativeFrameRate = structuredClone(motion);
  negativeFrameRate.canvas.frameRate = -24;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, negativeFrameRate), /dimensions and frameRate must be positive finite/);

  const nonFiniteFrameRate = structuredClone(motion);
  nonFiniteFrameRate.canvas.frameRate = Infinity;
  assert.throws(() => createFinalCompositionSpec(timeline, audio, nonFiniteFrameRate), /dimensions and frameRate must be positive finite/);
});

test("accepts valid fractional frameRate", () => {
  const fractional = structuredClone(motion);
  fractional.canvas.frameRate = 23.976;
  const spec = createFinalCompositionSpec(timeline, audio, fractional);
  assert.equal(spec.visualComposition.canvas.frameRate, 23.976);
});

test("postproduction CLI rejects unknown flags and missing values", () => {
  const temp = mkdtempSync(join(tmpdir(), "postproduction-cli-bad-"));
  try {
    const paths = ["timeline.json", "audio.json", "motion.json"].map(name => join(temp, name));
    [timeline, audio, motion].forEach((value, index) => writeFileSync(paths[index], JSON.stringify(value)));
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
