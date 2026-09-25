import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ProductionOrchestrator, createDefaultAdapters } from "./orchestrator.ts";
import type { AudioVoiceRegistry, SeriesBible, VisualProfile } from "./types.ts";

try {
  const [scriptPath, runDirectory, ...options] = process.argv.slice(2);
  if (!scriptPath || !runDirectory) usage();
  const seriesId = value(options, "--series-id") ?? "SERIES_DEFAULT";
  const episodeId = value(options, "--episode-id") ?? "EP_001";
  const profilePath = value(options, "--visual-profile");
  const voicesPath = value(options, "--voice-registry");
  if (!profilePath || !voicesPath) throw new Error("--visual-profile and --voice-registry are required.");
  const profile = await json<VisualProfile>(profilePath, "VisualProfile");
  const voices = await json<AudioVoiceRegistry>(voicesPath, "AudioVoiceRegistry");
  const biblePath = value(options, "--series-bible");
  const bible = biblePath ? await json<SeriesBible>(biblePath, "SeriesBible") : undefined;
  const orchestrator = new ProductionOrchestrator({ adapters: createDefaultAdapters({ seriesId, visualProfile: profile, voices, provider: (value(options, "--provider") as "fake" | "openai" | undefined), seriesBible: bible }) });
  const review = await orchestrator.run({ scriptPath: resolve(scriptPath), seriesId, episodeId }, resolve(runDirectory));
  console.log(`V09_${review.status}: ${review.episodeId} -> ${review.videoOutputPath || "no-video-output"}`);
  process.exitCode = review.status === "READY" ? 0 : 1;
} catch (cause) { console.error(`ERROR: ${cause instanceof Error ? cause.message : String(cause)}`); process.exitCode = 2; }

function usage(): never { throw new Error("Usage: npm run orchestrate -- <script.md> <run-dir> --visual-profile profile.json --voice-registry voices.json [--series-id ID] [--episode-id ID] [--provider fake|openai] [--series-bible bible.json]"); }
function value(options: string[], name: string): string | undefined { const index = options.indexOf(name); return index < 0 ? undefined : options[index + 1]; }
async function json<T>(path: string, label: string): Promise<T> { try { return JSON.parse(await readFile(resolve(path), "utf8")) as T; } catch (cause) { throw new Error(`${label} could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); } }
