import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAudioRun, type SpeechProvider } from "../src/audio.ts";
import type { EpisodeSpec } from "../src/types.ts";

const spec: EpisodeSpec = {
  schemaVersion: "0.1",
  specVersion: 1,
  lifecycle: "VALIDATED",
  episode: { id: "EP_001", title: "The Awakening", seriesId: "SERIES_A" },
  registry: { characters: [{ id: "CHAR_KAEL", name: "Kael" }], locations: [{ id: "LOC_TEMPLE", name: "ruined_temple" }] },
  scenes: [{
    id: "SC_001", order: 1, title: "The Ruined Temple", location: { id: "LOC_TEMPLE", name: "ruined_temple" }, purpose: "A discovery.",
    shots: [{ id: "SH_001_001", order: 1, purpose: "Reveal.", characterIds: ["CHAR_KAEL"], narration: "The symbol had been buried for centuries.", dialogue: "Kael: What is this?", visual: "An ancient symbol.", plannedTiming: { min: 3.5, target: 4.2, max: 5 } }]
  }],
  provenance: { parser: "episode-production-agent", parserVersion: "0.1.0" }
};
const root = dirname(dirname(fileURLToPath(import.meta.url)));

function fakeProvider(durations: number[]): SpeechProvider {
  let call = 0;
  return {
    name: "macos-say",
    async synthesize(_text, _voice, outputPath) { await mkdir(join(outputPath, ".."), { recursive: true }); await writeFile(outputPath, "audio"); },
    async measureDuration() { return durations[call++]!; }
  };
}

test("creates versioned audio assets and an audio-led realized timeline", async () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-audio-"));
  try {
    const result = await createAudioRun(spec, {
      outputPath: join(temp, "assets"),
      voices: { narrator: "Samantha", characters: { Kael: "Daniel" } },
      provider: fakeProvider([2.5, 1.25]),
      generatedAt: new Date("2026-09-25T12:00:00.000Z")
    });
    assert.equal(result.manifest.assets.length, 2);
    assert.deepEqual(result.manifest.assets.map(asset => [asset.id, asset.voice, asset.path]), [
      ["AST_SH_001_001_NARRATION", "Samantha", "assets/AST_SH_001_001_NARRATION.aiff"],
      ["AST_SH_001_001_DIALOGUE", "Daniel", "assets/AST_SH_001_001_DIALOGUE.aiff"]
    ]);
    assert.deepEqual(result.timeline.segments.map(segment => [segment.id, segment.startSeconds, segment.endSeconds, segment.speaker]), [
      ["SEG_SH_001_001_NARRATION", 0, 2.5, undefined],
      ["SEG_SH_001_001_DIALOGUE", 2.5, 3.75, "Kael"]
    ]);
    assert.equal(result.timeline.totalDurationSeconds, 3.75);
    assert.equal(result.timeline.timelineVersion, 1);
    assert.equal(result.timeline.sourceSpecVersion, 1);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("records an explicit timeline version for a regenerated audio timeline", async () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-audio-"));
  try {
    const result = await createAudioRun(spec, { outputPath: temp, voices: { narrator: "Samantha" }, provider: fakeProvider([1, 1]), timelineVersion: 2 });
    assert.equal(result.timeline.timelineVersion, 2);
    assert.equal(result.timeline.sourceSpecVersion, 1);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("fails closed when dialogue names a speaker outside the shot", async () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-audio-"));
  try {
    const invalid = structuredClone(spec);
    invalid.scenes[0].shots[0].dialogue = "Mira: What is this?";
    await assert.rejects(createAudioRun(invalid, { outputPath: temp, voices: { narrator: "Samantha" }, provider: fakeProvider([1]) }), /not declared/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("falls back to the narrator voice for dialogue without a character assignment", async () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-audio-"));
  try {
    const result = await createAudioRun(spec, { outputPath: temp, voices: { narrator: "Samantha" }, provider: fakeProvider([1, 1]) });
    assert.equal(result.manifest.assets[1].voice, "Samantha");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("canonicalizes a case-insensitive dialogue speaker before selecting its voice", async () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-audio-"));
  try {
    const caseVariant = structuredClone(spec);
    caseVariant.scenes[0].shots[0].dialogue = "kael: What is this?";
    const result = await createAudioRun(caseVariant, { outputPath: temp, voices: { narrator: "Samantha", characters: { Kael: "Daniel" } }, provider: fakeProvider([1, 1]) });
    assert.equal(result.timeline.segments[1].speaker, "Kael");
    assert.equal(result.manifest.assets[1].voice, "Daniel");
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("rejects a DRAFT EpisodeSpec before generating audio", async () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-audio-"));
  try {
    const draft = structuredClone(spec);
    draft.lifecycle = "DRAFT";
    await assert.rejects(createAudioRun(draft, { outputPath: temp, voices: { narrator: "Samantha" }, provider: fakeProvider([1]) }), /lifecycle VALIDATED/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("rejects malformed EpisodeSpec input before generating audio", async () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-audio-"));
  try {
    await assert.rejects(createAudioRun({ lifecycle: "VALIDATED", schemaVersion: "0.1" } as EpisodeSpec, { outputPath: temp, voices: { narrator: "Samantha" }, provider: fakeProvider([1]) }), /missing a valid episode.id/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("rejects non-positive measured durations", async () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-audio-"));
  try {
    await assert.rejects(createAudioRun(spec, { outputPath: temp, voices: { narrator: "Samantha" }, provider: fakeProvider([0]) }), /invalid duration/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test("audio CLI rejects an existing empty output directory without invoking a provider", () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-audio-cli-"));
  try {
    const episodePath = join(temp, "episode.json");
    const voicesPath = join(temp, "voices.json");
    const outputPath = join(temp, "run");
    writeFileSync(episodePath, JSON.stringify(spec));
    writeFileSync(voicesPath, JSON.stringify({ narrator: "Samantha" }));
    mkdirSync(outputPath);
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/audio-cli.ts", episodePath, outputPath, "--voice-registry", voicesPath], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Refusing to write into existing/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
