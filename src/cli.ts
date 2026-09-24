import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileEpisode } from "./compiler.ts";
import { parseStructuredMarkdown } from "./parser.ts";
import type { EntityRegistry } from "./types.ts";

const [input, output, ...options] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: npm run parse -- <episode.md> <output-dir> [--series-bible bible.json] [--series-id ID]");
  process.exit(2);
}
const option = (name: string) => options[options.indexOf(name) + 1];
const biblePath = option("--series-bible");
const seriesId = option("--series-id") ?? "SERIES_DEFAULT";
const markdown = await readFile(resolve(input), "utf8");
const known: EntityRegistry | undefined = biblePath ? JSON.parse(await readFile(resolve(biblePath), "utf8")) : undefined;
const parsed = parseStructuredMarkdown(markdown);
const { episode, report } = compileEpisode(parsed.episode, parsed.findings, seriesId, known);
await mkdir(resolve(output), { recursive: true });
await writeFile(resolve(output, "episode.json"), `${JSON.stringify(episode, null, 2)}\n`);
await writeFile(resolve(output, "validation.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${report.status}: ${report.summary.errors} errors, ${report.summary.warnings} warnings`);
process.exitCode = report.status === "FAIL" ? 1 : 0;
