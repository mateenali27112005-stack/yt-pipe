import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import type { AudioAssetManifest, AudioVoiceRegistry, EpisodeSpec, RealizedTimeline } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface SpeechProvider {
  name: "macos-say";
  synthesize(text: string, voice: string, outputPath: string): Promise<void>;
  measureDuration(outputPath: string): Promise<number>;
}

export interface AudioRunOptions {
  outputPath: string;
  voices: AudioVoiceRegistry;
  timelineVersion?: number;
  provider?: SpeechProvider;
  generatedAt?: Date;
}

export async function createAudioRun(spec: EpisodeSpec, options: AudioRunOptions): Promise<{ manifest: AudioAssetManifest; timeline: RealizedTimeline }> {
  assertValidatedEpisodeSpec(spec);
  const timelineVersion = options.timelineVersion ?? 1;
  if (!Number.isInteger(timelineVersion) || timelineVersion < 1) throw new Error("Timeline version must be a positive integer.");
  const provider = options.provider ?? macosSayProvider;
  const generatedAt = (options.generatedAt ?? new Date()).toISOString();
  const assets: AudioAssetManifest["assets"] = [];
  const segments: RealizedTimeline["segments"] = [];
  const characters = new Map(spec.registry.characters.map(character => [character.id, character.name]));
  let cursor = 0;
  await mkdir(options.outputPath, { recursive: true });

  for (const scene of spec.scenes) {
    for (const shot of scene.shots) {
      const inputs = segmentInputs(shot, characters, options.voices);
      for (const input of inputs) {
        const assetId = `AST_${shot.id}_${input.role.toUpperCase()}`;
        const segmentId = `SEG_${shot.id}_${input.role.toUpperCase()}`;
        const filename = `${assetId}.aiff`;
        const outputPath = `${options.outputPath}/${filename}`;
        await provider.synthesize(input.text, input.voice, outputPath);
        const durationSeconds = await provider.measureDuration(outputPath);
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error(`Audio provider returned an invalid duration for ${segmentId}.`);
        assets.push({ id: assetId, segmentId, shotId: shot.id, role: input.role, voice: input.voice, path: `assets/${filename}`, format: "aiff", durationSeconds, sha256: createHash("sha256").update(await readFile(outputPath)).digest("hex") });
        segments.push({ id: segmentId, shotId: shot.id, role: input.role, ...(input.speaker ? { speaker: input.speaker } : {}), text: input.text, startSeconds: cursor, endSeconds: cursor + durationSeconds, durationSeconds, audioAssetId: assetId });
        cursor += durationSeconds;
      }
    }
  }
  const base = { schemaVersion: "0.1" as const, episodeId: spec.episode.id, sourceSpecVersion: spec.specVersion, generatedAt };
  return {
    manifest: { ...base, provider: provider.name, assets },
    timeline: { ...base, timelineVersion, totalDurationSeconds: cursor, segments }
  };
}

function segmentInputs(shot: EpisodeSpec["scenes"][number]["shots"][number], characters: Map<string, string>, voices: AudioVoiceRegistry) {
  const inputs: Array<{ role: "narration" | "dialogue"; text: string; voice: string; speaker?: string }> = [];
  if (shot.narration?.trim()) inputs.push({ role: "narration", text: shot.narration.trim(), voice: voices.narrator });
  if (shot.dialogue?.trim()) {
    const match = shot.dialogue.match(/^([^:]+):\s*(.+)$/);
    const suppliedSpeaker = match?.[1]?.trim();
    const text = (match?.[2] ?? shot.dialogue).trim();
    const declaredNames = shot.characterIds.map(id => characters.get(id)).filter((value): value is string => Boolean(value));
    const speaker = suppliedSpeaker ? declaredNames.find(name => sameName(name, suppliedSpeaker)) : undefined;
    if (suppliedSpeaker && !speaker) throw new Error(`Dialogue speaker '${suppliedSpeaker}' is not declared on ${shot.id}.`);
    const characterVoice = speaker ? Object.entries(voices.characters ?? {}).find(([name]) => sameName(name, speaker))?.[1] : undefined;
    inputs.push({ role: "dialogue", text, voice: characterVoice ?? voices.narrator, ...(speaker ? { speaker } : {}) });
  }
  return inputs;
}

export function assertValidatedEpisodeSpec(value: unknown): asserts value is EpisodeSpec {
  if (!value || typeof value !== "object") throw new Error("Audio production requires an EpisodeSpec JSON object.");
  const spec = value as Partial<EpisodeSpec>;
  if (spec.schemaVersion !== "0.1") throw new Error("Audio production requires EpisodeSpec schemaVersion '0.1'.");
  if (spec.lifecycle !== "VALIDATED") throw new Error("Audio production requires an EpisodeSpec with lifecycle VALIDATED.");
  if (!spec.episode || typeof spec.episode.id !== "string" || !spec.episode.id.trim()) throw new Error("EpisodeSpec is missing a valid episode.id.");
  if (!Number.isInteger(spec.specVersion) || spec.specVersion < 1) throw new Error("EpisodeSpec is missing a positive integer specVersion.");
  if (!spec.registry || !Array.isArray(spec.registry.characters) || !Array.isArray(spec.registry.locations)) throw new Error("EpisodeSpec registry must contain character and location arrays.");
  if (!Array.isArray(spec.scenes) || spec.scenes.length === 0) throw new Error("EpisodeSpec must contain at least one scene.");
  for (const scene of spec.scenes) {
    if (!scene || typeof scene.id !== "string" || !Array.isArray(scene.shots)) throw new Error("EpisodeSpec contains an invalid scene.");
    for (const shot of scene.shots) {
      if (!shot || typeof shot.id !== "string" || !Array.isArray(shot.characterIds)) throw new Error("EpisodeSpec contains an invalid shot.");
      if (shot.narration !== undefined && typeof shot.narration !== "string") throw new Error(`EpisodeSpec narration must be text for ${shot.id}.`);
      if (shot.dialogue !== undefined && typeof shot.dialogue !== "string") throw new Error(`EpisodeSpec dialogue must be text for ${shot.id}.`);
    }
  }
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}

export const macosSayProvider: SpeechProvider = {
  name: "macos-say",
  async synthesize(text, voice, outputPath) {
    await execFileAsync("/usr/bin/say", ["-v", voice, "-o", outputPath, "--file-format=AIFF", text]);
    const file = await stat(outputPath);
    if (file.size <= 4096) throw new Error(`macOS speech synthesis produced no audio data at ${outputPath}. Confirm the selected voice is installed and speech synthesis is available.`);
  },
  async measureDuration(outputPath) {
    await access(outputPath);
    const { stdout } = await execFileAsync("/usr/bin/afinfo", [outputPath]);
    const match = stdout.match(/estimated duration:\s*([0-9]+(?:\.[0-9]+)?)\s*sec/);
    if (!match) throw new Error(`Could not measure audio duration for ${outputPath}.`);
    return Number(match[1]);
  }
};
