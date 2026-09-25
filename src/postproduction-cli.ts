import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createFinalCompositionSpec } from "./postproduction.ts";
import type { AudioAssetManifest, MotionCompositionPlan, RealizedTimeline, AssetManifest } from "./types.ts";

try {
  const args = process.argv.slice(2);
  const positionalArgs: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const flag = args[i];
      if (flag === '--overwrite') {
        options.set(flag, true);
      } else if (flag === '--composition-version' || flag === '--music-style') {
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          options.set(flag, args[i + 1]);
          i++;
        } else {
          options.set(flag, true);
        }
      } else {
        throw new Error(`Unknown flag: ${flag}`);
      }
    } else {
      positionalArgs.push(args[i]);
    }
  }
  if (positionalArgs.length !== 5) usage();
  const [timelinePath, audioPath, motionPath, assetManifestPath, output] = positionalArgs;

  const outputPath = resolve(output);
  const overwrite = options.has("--overwrite");
  await ensureNewOutput(outputPath, overwrite);
  
  const compositionVersionArg = options.get("--composition-version");
  if (options.has("--composition-version") && compositionVersionArg === true) throw new Error("Missing value for --composition-version");
  const musicStyleArg = options.get("--music-style");
  if (options.has("--music-style") && musicStyleArg === true) throw new Error("Missing value for --music-style");

  const timeline = await readJson<RealizedTimeline>(resolve(timelinePath), "RealizedTimeline");
  const audio = await readJson<AudioAssetManifest>(resolve(audioPath), "AudioAssetManifest");
  const motion = await readJson<MotionCompositionPlan>(resolve(motionPath), "MotionCompositionPlan");
  const assetManifest = await readJson<AssetManifest>(resolve(assetManifestPath), "AssetManifest");
  await mkdir(dirname(outputPath), { recursive: true });
  
  const staging = await mkdtemp(`${outputPath}.staging-`);
  let backupPath;
  try {
    const composition = createFinalCompositionSpec(timeline, audio, motion, assetManifest, { compositionVersion: numberOption(compositionVersionArg as string | undefined, "--composition-version") ?? 1, ...(musicStyleArg ? { musicStyle: musicStyleArg as string } : {}) });
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

function usage(): never { throw new Error("Usage: npm run postproduction-plan -- <realized_timeline.json> <audio_manifest.json> <motion_composition_plan.json> <asset_manifest.json> <output-dir> [--composition-version N] [--music-style text] [--overwrite]"); }
function optionValue(args: string[], name: string): string | undefined { const index = args.indexOf(name); return index < 0 || index + 1 >= args.length || args[index + 1].startsWith('--') ? undefined : args[index + 1]; }
function numberOption(value: string | undefined, flag: string): number | undefined { if (value === undefined) return undefined; if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`${flag} must be a positive integer.`); return Number(value); }
async function readJson<T>(path: string, label: string): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (cause) { throw new Error(`${label} could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); } }
async function ensureNewOutput(path: string, overwrite: boolean): Promise<void> { if (overwrite) return; try { await access(path); throw new Error(`Refusing to write into existing ${path}. Choose a new run directory or pass --overwrite explicitly.`); } catch (cause) { if (cause instanceof Error && cause.message.startsWith("Refusing")) throw cause; } }
