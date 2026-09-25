import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createFinalCompositionSpec } from "./postproduction.ts";
import type { AudioAssetManifest, MotionCompositionPlan, RealizedTimeline } from "./types.ts";

try {
  const args = process.argv.slice(2);
  const positionalArgs = args.filter(a => !a.startsWith('--'));
  if (positionalArgs.length !== 4) usage();
  const [timelinePath, audioPath, motionPath, output] = positionalArgs;
  
  const options = args.filter(a => a.startsWith('--'));
  const validFlags = ['--overwrite', '--composition-version', '--music-style'];
  for (const opt of options) {
    if (!validFlags.some(f => opt.startsWith(f))) {
      throw new Error(`Unknown flag: ${opt}`);
    }
  }

  const outputPath = resolve(output);
  const overwrite = args.includes("--overwrite");
  await ensureNewOutput(outputPath, overwrite);
  
  const compositionVersionArg = optionValue(args, "--composition-version");
  if (args.includes("--composition-version") && compositionVersionArg === undefined) throw new Error("Missing value for --composition-version");
  const musicStyleArg = optionValue(args, "--music-style");
  if (args.includes("--music-style") && musicStyleArg === undefined) throw new Error("Missing value for --music-style");

  const timeline = await readJson<RealizedTimeline>(resolve(timelinePath), "RealizedTimeline");
  const audio = await readJson<AudioAssetManifest>(resolve(audioPath), "AudioAssetManifest");
  const motion = await readJson<MotionCompositionPlan>(resolve(motionPath), "MotionCompositionPlan");
  await mkdir(dirname(outputPath), { recursive: true });
  
  const staging = await mkdtemp(`${outputPath}.staging-`);
  let backupPath;
  try {
    const composition = createFinalCompositionSpec(timeline, audio, motion, { compositionVersion: numberOption(compositionVersionArg, "--composition-version") ?? 1, ...(musicStyleArg ? { musicStyle: musicStyleArg } : {}) });
    await writeFile(resolve(staging, "final_composition_spec.json"), `${JSON.stringify(composition, null, 2)}\n`);
    
    if (overwrite) {
      try {
        await access(outputPath);
        backupPath = `${outputPath}.backup-${Date.now()}`;
        await rename(outputPath, backupPath);
      } catch (e) {
        // outputPath does not exist, safe to proceed
      }
    }
    
    await rename(staging, outputPath);
    
    if (backupPath) {
      await rm(backupPath, { recursive: true, force: true }).catch(() => {});
    }
    
    console.log(`POSTPRODUCTION_PLAN_COMPLETE: ${composition.narrationDialogueTracks.length} audio tracks, ${composition.captions.length} captions`);
  } catch (cause) { 
    await rm(staging, { recursive: true, force: true }).catch(() => {}); 
    if (backupPath) {
      await rename(backupPath, outputPath).catch(() => {});
    }
    throw cause; 
  }
} catch (cause) { console.error(`ERROR: ${cause instanceof Error ? cause.message : String(cause)}`); process.exitCode = 2; }

function usage(): never { throw new Error("Usage: npm run postproduction-plan -- <realized_timeline.json> <audio_manifest.json> <motion_composition_plan.json> <output-dir> [--composition-version N] [--music-style text] [--overwrite]"); }
function optionValue(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index < 0 || index + 1 >= args.length || args[index + 1].startsWith('--') ? undefined : args[index + 1]; }
function numberOption(value: string | undefined, flag: string): number | undefined { if (value === undefined) return undefined; if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${flag} must be a positive integer.`); return Number(value); }
async function readJson<T>(path: string, label: string): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (cause) { throw new Error(`${label} could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); } }
async function ensureNewOutput(path: string, overwrite: boolean): Promise<void> { if (overwrite) return; try { await access(path); throw new Error(`Refusing to write into existing ${path}. Choose a new run directory or pass --overwrite explicitly.`); } catch (cause) { if (cause instanceof Error && cause.message.startsWith("Refusing")) throw cause; } }
