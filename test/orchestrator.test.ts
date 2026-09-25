import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProductionOrchestrator } from "../src/orchestrator.ts";
import type { EpisodeQCReport, ProductionAdapters, ProductionInput, StageContext } from "../src/orchestrator-types.ts";

function input(text = "approved script"): ProductionInput { return { scriptText: text, seriesId: "SERIES_A", episodeId: "EP_001" }; }

function adapters(options: { continuity?: "PASS" | "BLOCKING"; qc?: EpisodeQCReport[]; decision?: "SKIP" | "RETRY" | "ESCALATE"; failAudio?: boolean; counters?: Record<string, number> } = {}): ProductionAdapters {
  const counters = options.counters ?? {};
  const count = (name: string) => { counters[name] = (counters[name] ?? 0) + 1; };
  let audioFailed = false;
  let qcIndex = 0;
  return {
    async parse() { count("parse"); return { data: { episode: { episode: { id: "EP_001" } }, report: { findings: [] } } }; },
    async continuity() { count("continuity"); return { data: { status: options.continuity ?? "PASS", findings: [] } }; },
    async plan() { count("plan"); return { data: { planned: true } }; },
    async audio() { count("audio"); if (options.failAudio && !audioFailed) { audioFailed = true; throw new Error("injected audio interruption"); } return { data: { manifest: {}, timeline: { totalDurationSeconds: 12 } }, costs: [{ timestamp: "2026-09-26T00:00:00.000Z", stage: "AUDIO_GENERATED", provider: "test", model: "test-tts", operation: "speech", quantity: 1, estimatedUsd: 0.12 }] }; },
    async visuals() { count("visuals"); return { data: { assets: ["shot-1"] }, costs: [{ timestamp: "2026-09-26T00:00:00.000Z", stage: "VISUALS_GENERATED", provider: "test", model: "test-image", operation: "image", quantity: 1, estimatedUsd: 0.25 }] }; },
    async render() { count("render"); return { data: { composition: { durationSeconds: 12 }, videoOutputPath: "output/final.mp4" } }; },
    async qc() { count("qc"); return { data: (options.qc ?? [{ status: "PASS", findings: [] }])[qcIndex++] }; },
    async decideRepairs() { count("decide"); return options.decision ?? "RETRY"; },
    async repair() { count("repair"); return { data: { status: "REPAIRED", actions: ["regenerated failing shot"] }, costs: [{ timestamp: "2026-09-26T00:00:00.000Z", stage: "REPAIRED", provider: "test", model: "test-repair", operation: "repair", quantity: 1, estimatedUsd: 0.05 }] }; }
  };
}

test("runs all stages, persists a completed review, and accumulates event costs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v09-success-"));
  try {
    const review = await new ProductionOrchestrator({ adapters: adapters() }).run(input(), directory);
    assert.equal(review.status, "READY");
    assert.equal(review.durationSeconds, 12);
    assert.equal(review.cost.entries.length, 2);
    assert.equal(review.cost.estimatedTotalUsd, 0.37);
    const state = JSON.parse(readFileSync(join(directory, ".production-state.json"), "utf8"));
    assert.equal(state.currentStage, "COMPLETED");
    assert.match(state.checkpoints.find((checkpoint: { stage: string }) => checkpoint.stage === "AUDIO_GENERATED").dataHash, /^[a-f0-9]{64}$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("resumes an interrupted stage without repeating prior stages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v09-resume-"));
  const counters: Record<string, number> = {};
  try {
    await assert.rejects(new ProductionOrchestrator({ adapters: adapters({ failAudio: true, counters }) }).run(input(), directory), /injected audio interruption/);
    assert.deepEqual(counters, { parse: 1, continuity: 1, plan: 1, audio: 1 });
    const review = await new ProductionOrchestrator({ adapters: adapters({ counters }) }).run(input(), directory);
    assert.equal(review.status, "READY");
    assert.deepEqual(counters, { parse: 1, continuity: 1, plan: 1, audio: 2, visuals: 1, render: 1, qc: 1 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("halts at CONTINUITY_CHECKED for a blocking continuity finding", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v09-continuity-"));
  try {
    const review = await new ProductionOrchestrator({ adapters: adapters({ continuity: "BLOCKING" }) }).run(input(), directory);
    assert.equal(review.status, "FAILED");
    const state = JSON.parse(readFileSync(join(directory, ".production-state.json"), "utf8"));
    assert.equal(state.currentStage, "CONTINUITY_CHECKED");
    assert.equal(state.errors[0].stage, "CONTINUITY_CHECKED");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("changed input invalidates prior checkpoints and restarts parsing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v09-invalidate-"));
  const first: Record<string, number> = {};
  const second: Record<string, number> = {};
  try {
    await new ProductionOrchestrator({ adapters: adapters({ counters: first }) }).run(input(), directory);
    await new ProductionOrchestrator({ adapters: adapters({ counters: second }) }).run(input("changed script"), directory);
    assert.equal(second.parse, 1);
    assert.equal(second.continuity, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("WARN can be explicitly skipped, while FAIL retries through repair", async () => {
  const warnDirectory = mkdtempSync(join(tmpdir(), "v09-warn-"));
  const repairDirectory = mkdtempSync(join(tmpdir(), "v09-repair-"));
  try {
    const warn = await new ProductionOrchestrator({ adapters: adapters({ qc: [{ status: "WARN", findings: [] }], decision: "SKIP" }) }).run(input(), warnDirectory);
    assert.equal(warn.status, "READY");
    const repair = await new ProductionOrchestrator({ adapters: adapters({ qc: [{ status: "FAIL", findings: [] }, { status: "PASS", findings: [] }], decision: "RETRY" }) }).run(input(), repairDirectory);
    assert.equal(repair.status, "READY");
    assert.equal(repair.repairReport?.status, "REPAIRED");
  } finally { rmSync(warnDirectory, { recursive: true, force: true }); rmSync(repairDirectory, { recursive: true, force: true }); }
});

test("fails after the configured maximum repair cycles", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v09-repair-limit-"));
  try {
    const fail = { status: "FAIL" as const, findings: [] };
    const review = await new ProductionOrchestrator({ maxRepairCycles: 2, adapters: adapters({ qc: [fail, fail, fail], decision: "RETRY" }) }).run(input(), directory);
    assert.equal(review.status, "FAILED");
    const state = JSON.parse(readFileSync(join(directory, ".production-state.json"), "utf8"));
    assert.equal(state.costs.entries.filter((entry: { operation: string }) => entry.operation === "repair").length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rejects a corrupted checkpoint artifact", async () => {
  const directory = mkdtempSync(join(tmpdir(), "v09-corrupt-"));
  try {
    await new ProductionOrchestrator({ adapters: adapters() }).run(input(), directory);
    const artifactPath = join(directory, "artifacts", "PARSED.json");
    const original = readFileSync(artifactPath, "utf8");
    const corrupted = original.replace("EP_001", "EP_CORRUPTED");
    writeFileSync(artifactPath, corrupted);
    await assert.rejects(new ProductionOrchestrator({ adapters: adapters() }).run(input(), directory), /Checkpoint integrity failure for PARSED/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
