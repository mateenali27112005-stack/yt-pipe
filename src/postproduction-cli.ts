import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { publishDirectory } from "./directory-publication.ts";
import { createFinalCompositionSpec } from "./postproduction.ts";
import type { AudioAssetManifest, MotionCompositionPlan, RealizedTimeline } from "./types.ts";

try {
  const [timelinePath, audioPath, motionPath, output, ...options] = process.argv.slice(2);
  if (!timelinePath || !audioPath || !motionPath || !output) usage();
  const outputPath = resolve(output);
  const parsedOptions = parseOptions(options);
  const timeline = await readJson<RealizedTimeline>(resolve(timelinePath), "RealizedTimeline");
  const audio = await readJson<AudioAssetManifest>(resolve(audioPath), "AudioAssetManifest");
  const motion = await readJson<MotionCompositionPlan>(resolve(motionPath), "MotionCompositionPlan");
  await mkdir(dirname(outputPath), { recursive: true });
  const staging = await mkdtemp(`${outputPath}.staging-`);
  try {
    const composition = createFinalCompositionSpec(timeline, audio, motion, { compositionVersion: parsedOptions.compositionVersion ?? 1, ...(parsedOptions.musicStyle ? { musicStyle: parsedOptions.musicStyle } : {}) });
    await writeFile(resolve(staging, "final_composition_spec.json"), `${JSON.stringify(composition, null, 2)}\n`);
    await publishDirectory(staging, outputPath, parsedOptions.overwrite);
    console.log(`POSTPRODUCTION_PLAN_COMPLETE: ${composition.narrationDialogueTracks.length} audio tracks, ${composition.captions.length} captions`);
  } catch (cause) { await rm(staging, { recursive: true, force: true }); throw cause; }
} catch (cause) { console.error(`ERROR: ${cause instanceof Error ? cause.message : String(cause)}`); process.exitCode = 2; }

function usage(): never { throw new Error("Usage: npm run postproduction-plan -- <realized_timeline.json> <audio_manifest.json> <motion_composition_plan.json> <output-dir> [--composition-version N] [--music-style text] [--overwrite]"); }
function numberOption(value: string | undefined, flag: string): number | undefined { if (value === undefined) return undefined; if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${flag} must be a positive integer.`); return Number(value); }
async function readJson<T>(path: string, label: string): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (cause) { throw new Error(`${label} could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); } }
function parseOptions(options: string[]): { overwrite: boolean; compositionVersion?: number; musicStyle?: string } {
  let overwrite = false;
  let compositionVersion: number | undefined;
  let musicStyle: string | undefined;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--overwrite") { if (overwrite) throw new Error("--overwrite may only be supplied once."); overwrite = true; continue; }
    if (option !== "--composition-version" && option !== "--music-style") throw new Error(`Unknown option '${option}'.`);
    const value = options[++index];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
    if (option === "--composition-version") { if (compositionVersion !== undefined) throw new Error("--composition-version may only be supplied once."); compositionVersion = numberOption(value, option); }
    else { if (musicStyle !== undefined) throw new Error("--music-style may only be supplied once."); musicStyle = value; }
  }
  return { overwrite, compositionVersion, musicStyle };
}
