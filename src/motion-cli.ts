import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createMotionCompositionPlan } from "./motion.ts";
import type { AssetManifest, RealizedTimeline, ShotVisualSpec } from "./types.ts";

try {
  const [timelinePath, visualSpecPath, manifestPath, output, ...options] = process.argv.slice(2);
  if (!timelinePath || !visualSpecPath || !manifestPath || !output) usage();
  const motionPlanVersion = numberOption(optionValue(options, "--motion-plan-version"), "--motion-plan-version") ?? 1;
  const overwrite = options.includes("--overwrite");
  const outputPath = resolve(output);
  await ensureNewOutput(outputPath, overwrite);
  const timeline = await readJson<RealizedTimeline>(resolve(timelinePath), "RealizedTimeline");
  const visualSpec = await readJson<ShotVisualSpec>(resolve(visualSpecPath), "ShotVisualSpec");
  const manifest = await readJson<AssetManifest>(resolve(manifestPath), "AssetManifest");
  await mkdir(dirname(outputPath), { recursive: true });
  const stagingPath = await mkdtemp(`${outputPath}.staging-`);
  try {
    const plan = createMotionCompositionPlan(timeline, visualSpec, manifest, { motionPlanVersion });
    await writeFile(resolve(stagingPath, "motion_composition_plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    if (overwrite) await rm(outputPath, { recursive: true, force: true });
    await rename(stagingPath, outputPath);
    console.log(`MOTION_PLAN_COMPLETE: ${plan.shots.length} composited shots`);
  } catch (cause) {
    await rm(stagingPath, { recursive: true, force: true });
    throw cause;
  }
} catch (cause) {
  console.error(`ERROR: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 2;
}

function usage(): never { throw new Error("Usage: npm run motion-plan -- <realized_timeline.json> <shot_visual_spec.json> <asset_manifest.json> <output-dir> [--motion-plan-version N] [--overwrite]"); }
function optionValue(options: string[], name: string): string | undefined { const index = options.indexOf(name); return index < 0 ? undefined : options[index + 1]; }
function numberOption(value: string | undefined, flag: string): number | undefined { if (value === undefined) return undefined; if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${flag} must be a positive integer.`); return Number(value); }
async function readJson<T>(path: string, label: string): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (cause) { throw new Error(`${label} could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); } }
async function ensureNewOutput(path: string, overwrite: boolean): Promise<void> {
  if (overwrite) return;
  try { await access(path); throw new Error(`Refusing to write into existing ${path}. Choose a new run directory or pass --overwrite explicitly.`); } catch (cause) { if (cause instanceof Error && cause.message.startsWith("Refusing")) throw cause; }
}
