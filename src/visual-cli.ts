import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createVisualPlan } from "./visual.ts";
import type { EpisodeSpec, RealizedTimeline, VisualProfile } from "./types.ts";

try {
  const [episodePath, timelinePath, output, ...options] = process.argv.slice(2);
  if (!episodePath || !timelinePath || !output) usage();
  const option = (name: string) => { const index = options.indexOf(name); return index === -1 ? undefined : options[index + 1]; };
  const profilePath = option("--visual-profile");
  if (!profilePath) throw new Error("--visual-profile is required.");
  const outputPath = resolve(output);
  const overwrite = options.includes("--overwrite");
  await ensureNewOutput(outputPath, overwrite);
  const spec = await readJson<EpisodeSpec>(resolve(episodePath), "EpisodeSpec");
  const timeline = await readJson<RealizedTimeline>(resolve(timelinePath), "RealizedTimeline");
  const profile = await readJson<VisualProfile>(resolve(profilePath), "VisualProfile");
  await mkdir(dirname(outputPath), { recursive: true });
  const stagingPath = await mkdtemp(`${outputPath}.staging-`);
  try {
    const { visualSpec, manifest } = createVisualPlan(spec, timeline, { profile });
    await writeFile(resolve(stagingPath, "shot_visual_spec.json"), `${JSON.stringify(visualSpec, null, 2)}\n`);
    await writeFile(resolve(stagingPath, "asset_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (overwrite) await rm(outputPath, { recursive: true, force: true });
    await rename(stagingPath, outputPath);
    console.log(`VISUAL_PLAN_COMPLETE: ${visualSpec.shots.length} shot specs, ${manifest.assets.length} planned assets`);
  } catch (cause) {
    await rm(stagingPath, { recursive: true, force: true });
    throw cause;
  }
} catch (cause) {
  console.error(`ERROR: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 2;
}

function usage(): never { throw new Error("Usage: npm run visual-plan -- <episode.json> <realized_timeline.json> <output-dir> --visual-profile profile.json [--overwrite]"); }
async function readJson<T>(path: string, label: string): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (cause) { throw new Error(`${label} could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); } }
async function ensureNewOutput(outputPath: string, overwrite: boolean) {
  if (overwrite) return;
  try { await access(outputPath); throw new Error(`Refusing to write into existing ${outputPath}. Choose a new run directory or pass --overwrite explicitly.`); } catch (cause) { if (cause instanceof Error && cause.message.startsWith("Refusing")) throw cause; }
}
