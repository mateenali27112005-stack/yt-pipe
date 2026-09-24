import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertValidatedEpisodeSpec, createAudioRun } from "./audio.ts";
import type { AudioVoiceRegistry, EpisodeSpec } from "./types.ts";

try {
  const [episodePath, output, ...options] = process.argv.slice(2);
  if (!episodePath || !output) usage();
  const option = (name: string) => { const index = options.indexOf(name); return index === -1 ? undefined : options[index + 1]; };
  const voiceRegistryPath = option("--voice-registry");
  if (!voiceRegistryPath) throw new Error("--voice-registry is required.");
  const outputPath = resolve(output);
  const overwrite = options.includes("--overwrite");
  await ensureNewAudioRun(outputPath, overwrite);
  const spec = await readJson<EpisodeSpec>(resolve(episodePath), "EpisodeSpec");
  assertValidatedEpisodeSpec(spec);
  const voices = await readVoices(resolve(voiceRegistryPath));
  await mkdir(dirname(outputPath), { recursive: true });
  const stagingPath = await mkdtemp(`${outputPath}.staging-`);
  try {
    const { manifest, timeline } = await createAudioRun(spec, { outputPath: resolve(stagingPath, "assets"), voices });
    await writeFile(resolve(stagingPath, "audio_manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(resolve(stagingPath, "realized_timeline.json"), `${JSON.stringify(timeline, null, 2)}\n`);
    if (overwrite) await rm(outputPath, { recursive: true, force: true });
    await rename(stagingPath, outputPath);
    console.log(`AUDIO_COMPLETE: ${manifest.assets.length} assets, ${timeline.totalDurationSeconds.toFixed(3)} seconds`);
  } catch (cause) {
    await rm(stagingPath, { recursive: true, force: true });
    throw cause;
  }
} catch (cause) {
  console.error(`ERROR: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 2;
}

function usage(): never { throw new Error("Usage: npm run audio -- <episode.json> <output-dir> --voice-registry voices.json [--overwrite]"); }
async function readJson<T>(path: string, label: string): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (cause) { throw new Error(`${label} could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); }
}
async function readVoices(path: string): Promise<AudioVoiceRegistry> {
  const voices = await readJson<AudioVoiceRegistry>(path, "Voice registry");
  if (!voices || typeof voices.narrator !== "string" || !voices.narrator.trim()) throw new Error("Voice registry requires a non-empty 'narrator' voice.");
  if (voices.characters && (typeof voices.characters !== "object" || Object.values(voices.characters).some(voice => typeof voice !== "string" || !voice.trim()))) throw new Error("Voice registry character voices must be non-empty strings.");
  return voices;
}
async function ensureNewAudioRun(outputPath: string, overwrite: boolean) {
  if (overwrite) return;
  try {
    await access(outputPath);
    throw new Error(`Refusing to write into existing ${outputPath}. Choose a new run directory or pass --overwrite explicitly.`);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Refusing")) throw cause;
  }
}
