import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createFinalCompositionSpec } from "./postproduction.ts";
import type { AudioAssetManifest, MotionCompositionPlan, RealizedTimeline } from "./types.ts";

try {
  const [timelinePath, audioPath, motionPath, output, ...options] = process.argv.slice(2);
  if (!timelinePath || !audioPath || !motionPath || !output) usage();
  const outputPath = resolve(output);
  const overwrite = options.includes("--overwrite");
  await ensureNewOutput(outputPath, overwrite);
  const timeline = await readJson<RealizedTimeline>(resolve(timelinePath), "RealizedTimeline");
  const audio = await readJson<AudioAssetManifest>(resolve(audioPath), "AudioAssetManifest");
  const motion = await readJson<MotionCompositionPlan>(resolve(motionPath), "MotionCompositionPlan");
  await mkdir(dirname(outputPath), { recursive: true });
  const staging = await mkdtemp(`${outputPath}.staging-`);
  try {
    const composition = createFinalCompositionSpec(timeline, audio, motion, { compositionVersion: numberOption(optionValue(options, "--composition-version"), "--composition-version") ?? 1, ...(optionValue(options, "--music-style") ? { musicStyle: optionValue(options, "--music-style")! } : {}) });
    await writeFile(resolve(staging, "final_composition_spec.json"), `${JSON.stringify(composition, null, 2)}\n`);
    if (overwrite) await rm(outputPath, { recursive: true, force: true });
    await rename(staging, outputPath);
    console.log(`POSTPRODUCTION_PLAN_COMPLETE: ${composition.narrationDialogueTracks.length} audio tracks, ${composition.captions.length} captions`);
  } catch (cause) { await rm(staging, { recursive: true, force: true }); throw cause; }
} catch (cause) { console.error(`ERROR: ${cause instanceof Error ? cause.message : String(cause)}`); process.exitCode = 2; }

function usage(): never { throw new Error("Usage: npm run postproduction-plan -- <realized_timeline.json> <audio_manifest.json> <motion_composition_plan.json> <output-dir> [--composition-version N] [--music-style text] [--overwrite]"); }
function optionValue(options: string[], name: string): string | undefined { const index = options.indexOf(name); return index < 0 ? undefined : options[index + 1]; }
function numberOption(value: string | undefined, flag: string): number | undefined { if (value === undefined) return undefined; if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${flag} must be a positive integer.`); return Number(value); }
async function readJson<T>(path: string, label: string): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (cause) { throw new Error(`${label} could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); } }
async function ensureNewOutput(path: string, overwrite: boolean): Promise<void> { if (overwrite) return; try { await access(path); throw new Error(`Refusing to write into existing ${path}. Choose a new run directory or pass --overwrite explicitly.`); } catch (cause) { if (cause instanceof Error && cause.message.startsWith("Refusing")) throw cause; } }
