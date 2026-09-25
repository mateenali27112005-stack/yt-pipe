/**
 * V0.9 Master Orchestrator — End-to-End Tests
 * 
 * Uses valid byte-level mock media to satisfy the real QC engine and FakeRenderer 
 * to bypass FFmpeg.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { MasterOrchestrator } from "../src/orchestrator.ts";
import type { OrchestratorDependencies } from "../src/orchestrator.ts";
import type { SpeechProvider } from "../src/audio.ts";
import type { ImageProvider } from "../src/image.ts";
import type { SeriesBible } from "../src/types.ts";
import type { RenderResult, Renderer, FinalCompositionSpec } from "../src/renderer-types.ts";
import { createInitialState } from "../src/continuity.ts";

// --- Valid Media Builders ---

function makePNGChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); // Fake CRC is fine, QC doesn't check it
  return Buffer.concat([len, typeBuf, data, crc]);
}

function makeValidPNG(width = 1920, height = 1080): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // 8-bit
  ihdr.writeUInt8(2, 9); // Truecolor
  
  // Make some RGB data (not all black) so QC passes
  const idat = Buffer.from([0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00, 0xff]);
  return Buffer.concat([sig, makePNGChunk("IHDR", ihdr), makePNGChunk("IDAT", idat), makePNGChunk("IEND", Buffer.alloc(0))]);
}

function makeAIFFChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length, 0);
  return Buffer.concat([typeBuf, size, data]);
}

function makeValidAIFF(numSampleFrames = 88200): Buffer {
  const commData = Buffer.alloc(18);
  commData.writeUInt16BE(1, 0); // channels
  commData.writeUInt32BE(numSampleFrames, 2); // numSampleFrames
  commData.writeUInt16BE(16, 6); // sampleSize
  commData.writeUInt16BE(0x400e, 8); // 44100 Hz (IEEE 80-bit)
  commData.writeUInt32BE(0xac440000, 10);
  
  const ssndData = Buffer.alloc(8 + (numSampleFrames * 2));
  ssndData.writeUInt32BE(0, 0); // offset
  ssndData.writeUInt32BE(0, 4); // blockSize
  // Write some non-zero audio to pass FULL_SILENCE check
  for (let i = 0; i < numSampleFrames; i++) ssndData.writeInt16BE(1000, 8 + (i * 2));

  const commChunk = makeAIFFChunk("COMM", commData);
  const ssndChunk = makeAIFFChunk("SSND", ssndData);

  const formType = Buffer.from("AIFF", "ascii");
  const formSize = Buffer.alloc(4);
  formSize.writeUInt32BE(4 + commChunk.length + ssndChunk.length, 0);

  return Buffer.concat([Buffer.from("FORM", "ascii"), formSize, formType, commChunk, ssndChunk]);
}

// --- Fakes ---

class FakeRenderer implements Renderer {
  async render(context: FinalCompositionSpec, options: { outputPath: string }): Promise<RenderResult> {
    const output = Buffer.from("fake mp4 data");
    await writeFile(options.outputPath, output);
    return { status: "OK", outputPath: options.outputPath, format: "mp4", byteLength: output.byteLength, sha256: "0".repeat(64), rendererVersion: "fake-test" };
  }
}

function createFakeSpeechProvider(outputDir: string): SpeechProvider {
  return {
    name: "macos-say",
    synthesize: async (text, voice, outPath) => {
      await mkdir(outputDir, { recursive: true });
      await writeFile(outPath, makeValidAIFF());
    },
    measureDuration: async () => 2.0,
  };
}

function createFakeImageProvider(): ImageProvider {
  return {
    name: "fake-image",
    generate: async () => makeValidPNG(),
  };
}

function makeBible(): SeriesBible {
  return {
    schemaVersion: "0.1",
    bibleVersion: 1,
    seriesId: "SERIES_01",
    generatedAt: "2026-09-26T00:00:00.000Z",
    characters: [{
      id: "CHAR_31A019B375", name: "CHAR_KAEL",
      appearance: { hair: "dark", eyes: "amber", build: "athletic", clothing: "robes" },
      personalityVisualCues: [], referenceAssets: []
    }],
    locations: [{ id: "LOC_22479CDE0B", name: "LOC_TEMPLE", visualDescription: "old temple", referenceAssets: [] }],
    visualStyles: [{ id: "STYLE_DARK", name: "Dark", promptGuidance: "dark" }]
  };
}

const mockScript = `
# Episode: The Test
## Scene: The Ruined Temple
Location: LOC_TEMPLE
Time: night
Purpose: Test
### Shot
Purpose: Test shot
Characters:
- CHAR_KAEL
Visual: Kael stands
Dialogue: CHAR_KAEL: Hello world
Timing: min: 2 target: 3 max: 4
`;

// --- Tests ---

test("V0.9 Orchestrator: end-to-end success", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "v09-test-"));
  try {
    const deps: OrchestratorDependencies = {
      speechProvider: createFakeSpeechProvider(join(tmp, "audio")),
      imageProvider: createFakeImageProvider(),
      bible: makeBible(),
      initialContinuityState: createInitialState("SERIES_01", makeBible()),
      workingDirectory: tmp,
      renderer: new FakeRenderer()
    };
    
    const orchestrator = new MasterOrchestrator("run_1", "SERIES_01", "EP_1", deps);
    const result = await orchestrator.run(mockScript);
    
    if (result.status !== "READY") {
      console.log(JSON.stringify(result, null, 2));
      const stateStr = await readFile(join(tmp, "production-state.json"), "utf8");
      console.log("State:", stateStr);
    }
    assert.equal(result.status, "READY");
    
    const stateStr = await readFile(join(tmp, "production-state.json"), "utf8");
    const state = JSON.parse(stateStr);
    assert.equal(state.status, "COMPLETED");
    assert.equal(state.currentStage, "REVIEW_READY");
    
    // Validates cost tracking
    assert.ok(state.costs.entries.some((e: any) => e.stage === "AUDIO_GENERATED"));
    assert.ok(state.costs.entries.some((e: any) => e.stage === "VISUALS_GENERATED"));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("V0.9 Orchestrator: records active failed stage and resumes from it", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "v09-resume-test-"));
  try {
    const failingSpeechProvider = createFakeSpeechProvider(join(tmp, "audio"));
    failingSpeechProvider.synthesize = async () => { throw new Error("simulated TTS outage"); };
    const baseDeps: OrchestratorDependencies = {
      speechProvider: failingSpeechProvider,
      imageProvider: createFakeImageProvider(),
      bible: makeBible(),
      initialContinuityState: createInitialState("SERIES_01", makeBible()),
      workingDirectory: tmp,
      renderer: new FakeRenderer()
    };

    const first = await new MasterOrchestrator("run_resume", "SERIES_01", "EP_1", baseDeps).run(mockScript);
    assert.equal(first.status, "FAILED");
    const failedState = JSON.parse(await readFile(join(tmp, ".production-state.json"), "utf8"));
    assert.equal(failedState.currentStage, "AUDIO_GENERATED");
    assert.equal(failedState.activeStage, "AUDIO_GENERATED");
    assert.ok(failedState.checkpoints.some((checkpoint: any) => checkpoint.stage === "PLANNED"));
    assert.ok(!failedState.checkpoints.some((checkpoint: any) => checkpoint.stage === "AUDIO_GENERATED"));

    const resumed = await new MasterOrchestrator("run_resume", "SERIES_01", "EP_1", {
      ...baseDeps,
      speechProvider: createFakeSpeechProvider(join(tmp, "audio"))
    }).run(mockScript);
    assert.equal(resumed.status, "READY");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
