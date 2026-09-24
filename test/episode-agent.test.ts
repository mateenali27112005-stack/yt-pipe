import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileEpisode } from "../src/compiler.ts";
import { parseStructuredMarkdown } from "../src/parser.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const valid = `# Episode: The Awakening
## Scene: The Ruined Temple
Location: ruined_temple
Time: night
Purpose: Kael discovers the forbidden symbol.
### Shot
Purpose: Reveal the forbidden symbol.
Characters:
- Kael
Narration: The symbol had been buried for centuries.
Visual: Ancient glowing symbol carved into stone.
Timing: min: 3.5 target: 4.2 max: 5.0`;
const registry = { characters: ["Kael"], locations: ["ruined_temple"] };

function compile(markdown = valid, options = {}) {
  const parsed = parseStructuredMarkdown(markdown);
  return compileEpisode(parsed.episode, parsed.findings, { seriesId: "SERIES_A", episodeId: "EP_042", registry, generatedAt: new Date("2026-09-25T12:00:00.000Z"), ...options });
}

test("compiles a valid episode with structural IDs and an actual run timestamp", () => {
  const result = compile();
  assert.equal(result.report.status, "APPROVABLE");
  assert.equal(result.episode.episode.id, "EP_042");
  assert.equal(result.episode.scenes[0].id, "SC_001");
  assert.equal(result.episode.scenes[0].shots[0].id, "SH_001_001");
  assert.equal(result.report.generatedAt, "2026-09-25T12:00:00.000Z");
});

test("keeps structural IDs stable when mutable prose changes", () => {
  const revised = valid.replace("Reveal the forbidden symbol.", "Reveal the forbidden symbol as it awakens.").replace("Ancient glowing symbol carved into stone.", "Ancient symbol pulsing through cracked stone.");
  const original = compile();
  const changed = compile(revised);
  assert.equal(changed.episode.scenes[0].id, original.episode.scenes[0].id);
  assert.equal(changed.episode.scenes[0].shots[0].id, original.episode.scenes[0].shots[0].id);
});

test("rejects prose without an Episode or Scene", () => {
  const result = compile("Kael walks into a temple and sees something weird.");
  assert.equal(result.report.status, "FAIL");
  assert.ok(result.report.findings.some(f => f.code === "MISSING_EPISODE"));
  assert.ok(result.report.findings.some(f => f.code === "MISSING_SCENE"));
});

test("rejects duplicate scene and shot fields", () => {
  const duplicate = valid.replace("Time: night", "Time: night\nTime: dawn").replace("Visual: Ancient glowing symbol carved into stone.", "Visual: Ancient glowing symbol carved into stone.\nVisual: A second visual.");
  const result = compile(duplicate);
  assert.equal(result.report.status, "FAIL");
  assert.equal(result.report.findings.filter(f => f.code === "DUPLICATE_FIELD").length, 2);
});

test("rejects a duplicate Characters declaration", () => {
  const result = compile(valid.replace("Narration:", "Characters:\n- Kael\nNarration:"));
  assert.ok(result.report.findings.some(f => f.code === "DUPLICATE_FIELD"));
});

test("rejects interrupted character lists with a specific finding", () => {
  const result = compile(valid.replace("- Kael\nNarration:", "- Kael\n\n- Elara\nNarration:"));
  assert.ok(result.report.findings.some(f => f.code === "CHARACTER_LIST_INTERRUPTED"));
});

test("rejects timing ranges that are not positive and ordered", () => {
  const result = compile(valid.replace("min: 3.5 target: 4.2 max: 5.0", "min: 5 target: 4 max: 3"));
  assert.ok(result.report.findings.some(f => f.code === "INVALID_TIMING_RANGE"));
});

test("rejects invalid timing syntax", () => {
  const result = compile(valid.replace("min: 3.5 target: 4.2 max: 5.0", "min: fast target: 4 max: 5"));
  assert.ok(result.report.findings.some(f => f.code === "INVALID_TIMING_FORMAT"));
  assert.ok(result.report.findings.some(f => f.code === "MISSING_TIMING"));
});

test("reports unresolved registered entities without crashing", () => {
  const result = compile(valid.replace("- Kael", "- Mira"));
  assert.equal(result.report.status, "FAIL");
  assert.ok(result.report.findings.some(f => f.code === "UNRESOLVED_CHARACTER"));
});

test("reports missing required scene and shot fields", () => {
  const result = compile(valid.replace("Location: ruined_temple\n", "").replace("Visual: Ancient glowing symbol carved into stone.\n", ""));
  assert.ok(result.report.findings.some(f => f.code === "MISSING_LOCATION"));
  assert.ok(result.report.findings.some(f => f.code === "MISSING_VISUAL"));
});

test("records explicit immutable snapshot version lineage", () => {
  const result = compile(valid, { specVersion: 2, parentSpecVersion: 1 });
  assert.equal(result.episode.specVersion, 2);
  assert.equal(result.episode.parentSpecVersion, 1);
  assert.equal(result.report.status, "APPROVABLE");
});

test("rejects invalid snapshot version lineage", () => {
  const result = compile(valid, { specVersion: 1, parentSpecVersion: 1 });
  assert.ok(result.report.findings.some(f => f.code === "INVALID_PARENT_SPEC_VERSION"));
});

test("CLI writes a versioned snapshot and refuses an implicit overwrite", () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-agent-"));
  try {
    const source = join(temp, "episode.md");
    const registryPath = join(temp, "registry.json");
    const output = join(temp, "EP_001", "v1");
    writeFileSync(source, valid);
    writeFileSync(registryPath, JSON.stringify(registry));
    const args = ["--experimental-strip-types", "src/cli.ts", source, output, "--series-registry", registryPath, "--episode-id", "EP_001"];
    const first = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const episode = JSON.parse(readFileSync(join(output, "episode.json"), "utf8"));
    assert.equal(episode.episode.id, "EP_001");
    const second = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    assert.equal(second.status, 2);
    assert.match(second.stderr, /Refusing to overwrite/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI gives a friendly error for malformed registry JSON", () => {
  const temp = mkdtempSync(join(tmpdir(), "episode-agent-"));
  try {
    const source = join(temp, "episode.md");
    const registryPath = join(temp, "registry.json");
    writeFileSync(source, valid);
    writeFileSync(registryPath, "{not json}");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "src/cli.ts", source, join(temp, "out"), "--series-registry", registryPath], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Series registry could not be parsed/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
