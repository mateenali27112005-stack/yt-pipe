import assert from "node:assert/strict";
import test from "node:test";
import { compileEpisode } from "../src/compiler.ts";
import { parseStructuredMarkdown } from "../src/parser.ts";

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

test("compiles a valid episode into stable application-owned IDs", () => {
  const first = parseStructuredMarkdown(valid);
  const a = compileEpisode(first.episode, first.findings, "SERIES_A", { characters: ["Kael"], locations: ["ruined_temple"] });
  const second = parseStructuredMarkdown(valid);
  const b = compileEpisode(second.episode, second.findings, "SERIES_A", { characters: ["Kael"], locations: ["ruined_temple"] });
  assert.equal(a.report.status, "APPROVABLE");
  assert.deepEqual(a.episode, b.episode);
  assert.match(a.episode.scenes[0].id, /^SC_[A-F0-9]{10}$/);
  assert.match(a.episode.scenes[0].shots[0].id, /^SH_[A-F0-9]{10}$/);
  assert.equal(a.episode.lifecycle, "VALIDATED");
});

test("rejects prose without production structure", () => {
  const parsed = parseStructuredMarkdown("Kael walks into a temple and sees something weird.");
  const result = compileEpisode(parsed.episode, parsed.findings, "SERIES_A");
  assert.equal(result.report.status, "FAIL");
  assert.ok(result.report.findings.some(f => f.code === "MISSING_EPISODE"));
  assert.ok(result.report.findings.some(f => f.code === "MISSING_SCENE"));
});

test("detects timing violations and unresolved bible references", () => {
  const parsed = parseStructuredMarkdown(valid.replace("min: 3.5 target: 4.2 max: 5.0", "min: 5 target: 4 max: 3").replace("- Kael", "- Mira"));
  const result = compileEpisode(parsed.episode, parsed.findings, "SERIES_A", { characters: ["Kael"], locations: ["ruined_temple"] });
  assert.equal(result.report.status, "FAIL");
  assert.ok(result.report.findings.some(f => f.code === "INVALID_TIMING_RANGE"));
  assert.ok(result.report.findings.some(f => f.code === "UNRESOLVED_CHARACTER"));
});
