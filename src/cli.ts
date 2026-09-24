import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { compileEpisode } from "./compiler.ts";
import { parseStructuredMarkdown } from "./parser.ts";
import type { EntityRegistry } from "./types.ts";

try {
  const [input, output, ...options] = process.argv.slice(2);
  if (!input || !output) usage();
  const option = (name: string) => {
    const index = options.indexOf(name);
    return index === -1 ? undefined : options[index + 1];
  };
  const registryPath = option("--series-registry");
  const seriesId = option("--series-id") ?? "SERIES_DEFAULT";
  const episodeId = option("--episode-id") ?? "EP_001";
  const specVersion = numberOption(option("--spec-version"), "--spec-version") ?? 1;
  const parentSpecVersion = numberOption(option("--parent-spec-version"), "--parent-spec-version");
  const overwrite = options.includes("--overwrite");
  const markdown = await readFile(resolve(input), "utf8");
  const registry = registryPath ? await readRegistry(resolve(registryPath)) : undefined;
  const outputPath = resolve(output);
  await ensureNewSnapshot(outputPath, overwrite);
  const parsed = parseStructuredMarkdown(markdown);
  const { episode, report } = compileEpisode(parsed.episode, parsed.findings, { seriesId, episodeId, specVersion, parentSpecVersion, registry });
  await mkdir(outputPath, { recursive: true });
  await writeFile(resolve(outputPath, "episode.json"), `${JSON.stringify(episode, null, 2)}\n`);
  await writeFile(resolve(outputPath, "validation.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${report.status}: ${report.summary.errors} errors, ${report.summary.warnings} warnings`);
  process.exitCode = report.status === "FAIL" ? 1 : 0;
} catch (cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(`ERROR: ${message}`);
  process.exitCode = 2;
}

function usage(): never {
  throw new Error("Usage: npm run parse -- <episode.md> <output-dir> [--series-registry registry.json] [--series-id ID] [--episode-id ID] [--spec-version N] [--parent-spec-version N] [--overwrite]");
}

function numberOption(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${flag} must be a positive integer.`);
  return Number(value);
}

async function readRegistry(path: string): Promise<EntityRegistry> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (cause) {
    throw new Error(`Series registry could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!value || typeof value !== "object") throw new Error("Series registry must be a JSON object.");
  const registry = value as EntityRegistry;
  for (const key of ["characters", "locations"] as const) {
    if (registry[key] !== undefined && (!Array.isArray(registry[key]) || registry[key].some(entry => typeof entry !== "string" || !entry.trim()))) {
      throw new Error(`Series registry '${key}' must be an array of non-empty strings.`);
    }
  }
  return registry;
}

async function ensureNewSnapshot(outputPath: string, overwrite: boolean) {
  if (overwrite) return;
  for (const filename of ["episode.json", "validation.json"]) {
    try {
      await access(resolve(outputPath, filename));
      throw new Error(`Refusing to overwrite ${resolve(outputPath, filename)}. Choose a new versioned output directory or pass --overwrite explicitly.`);
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith("Refusing")) throw cause;
    }
  }
}
