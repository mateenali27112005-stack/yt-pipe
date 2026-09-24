import { execFile } from "node:child_process";
import { access, mkdir, stat } from "node:fs/promises";
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
  provider?: SpeechProvider;
  generatedAt?: Date;
}

export async function createAudioRun(spec: EpisodeSpec, options: AudioRunOptions): Promise<{ manifest: AudioAssetManifest; timeline: RealizedTimeline }> {
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
        assets.push({ id: assetId, segmentId, shotId: shot.id, role: input.role, voice: input.voice, path: `assets/${filename}`, format: "aiff", durationSeconds });
        segments.push({ id: segmentId, shotId: shot.id, role: input.role, ...(input.speaker ? { speaker: input.speaker } : {}), text: input.text, startSeconds: cursor, endSeconds: cursor + durationSeconds, durationSeconds, audioAssetId: assetId });
        cursor += durationSeconds;
      }
    }
  }
  const base = { schemaVersion: "0.1" as const, episodeId: spec.episode.id, sourceSpecVersion: spec.specVersion, generatedAt };
  return {
    manifest: { ...base, provider: provider.name, assets },
    timeline: { ...base, totalDurationSeconds: cursor, segments }
  };
}

function segmentInputs(shot: EpisodeSpec["scenes"][number]["shots"][number], characters: Map<string, string>, voices: AudioVoiceRegistry) {
  const inputs: Array<{ role: "narration" | "dialogue"; text: string; voice: string; speaker?: string }> = [];
  if (shot.narration?.trim()) inputs.push({ role: "narration", text: shot.narration.trim(), voice: voices.narrator });
  if (shot.dialogue?.trim()) {
    const match = shot.dialogue.match(/^([^:]+):\s*(.+)$/);
    const speaker = match?.[1]?.trim();
    const text = (match?.[2] ?? shot.dialogue).trim();
    const declaredNames = shot.characterIds.map(id => characters.get(id)).filter((value): value is string => Boolean(value));
    if (speaker && !declaredNames.some(name => name.localeCompare(speaker, undefined, { sensitivity: "accent" }) === 0)) throw new Error(`Dialogue speaker '${speaker}' is not declared on ${shot.id}.`);
    inputs.push({ role: "dialogue", text, voice: speaker ? (voices.characters?.[speaker] ?? voices.narrator) : voices.narrator, ...(speaker ? { speaker } : {}) });
  }
  return inputs;
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
