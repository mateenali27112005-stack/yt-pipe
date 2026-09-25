import { execFile } from "node:child_process";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { AudioAssetManifest, AudioVoiceRegistry, EpisodeSpec, RealizedTimeline } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface SpeechProvider {
  name: string;
  synthesize(text: string, voice: string, outputPath: string): Promise<void>;
  measureDuration(outputPath: string): Promise<number>;
}

export interface OpenAiSpeechProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voiceMap?: Record<string, string>;
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  fetchImpl?: typeof fetch;
  measureDuration?: (outputPath: string) => Promise<number>;
}

export function createOpenAiSpeechProvider(options: OpenAiSpeechProviderOptions = {}): SpeechProvider {
  const name = "openai-tts";
  return {
    name,
    async synthesize(text: string, voice: string, outputPath: string) {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for the OpenAI speech provider. Set it in process.env.OPENAI_API_KEY or pass apiKey in options.");
      }
      const fetchFunc = options.fetchImpl ?? globalThis.fetch;
      if (typeof fetchFunc !== "function") {
        throw new Error("Global fetch is unavailable. Provide fetchImpl in options.");
      }
      const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
      const model = options.model ?? process.env.OPENAI_TTS_MODEL ?? "tts-1";
      const format = options.responseFormat ?? "mp3";
      const mappedVoice = options.voiceMap?.[voice] ?? mapToOpenAiVoice(voice);

      const response = await fetchFunc(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: text,
          voice: mappedVoice,
          response_format: format
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`OpenAI TTS synthesis failed (${response.status}): ${errorText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length === 0) {
        throw new Error(`OpenAI TTS returned empty audio payload for '${text}'.`);
      }

      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, buffer);
    },
    async measureDuration(outputPath: string) {
      if (options.measureDuration) {
        return options.measureDuration(outputPath);
      }
      return measureAudioDurationDefault(outputPath);
    }
  };
}

export const openAiSpeechProvider: SpeechProvider = createOpenAiSpeechProvider();

function mapToOpenAiVoice(voice: string): string {
  const lower = voice.toLowerCase();
  const validVoices = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
  if (validVoices.includes(lower)) return lower;
  if (lower.includes("samantha") || lower.includes("female") || lower.includes("narrator")) return "nova";
  if (lower.includes("daniel") || lower.includes("male") || lower.includes("kael")) return "onyx";
  return "alloy";
}

async function measureAudioDurationDefault(outputPath: string): Promise<number> {
  await access(outputPath);
  try {
    const { stdout } = await execFileAsync("/usr/bin/afinfo", [outputPath]);
    const match = stdout.match(/estimated duration:\s*([0-9]+(?:\.[0-9]+)?)\s*sec/);
    if (match) return Number(match[1]);
  } catch {
    // try ffprobe fallback
  }
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", outputPath]);
    const dur = Number(stdout.trim());
    if (Number.isFinite(dur) && dur > 0) return dur;
  } catch {
    // ignore
  }
  throw new Error(`Could not measure audio duration for ${outputPath}. Ensure afinfo or ffprobe is available.`);
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
        assets.push({ id: assetId, segmentId, shotId: shot.id, role: input.role, voice: input.voice, path: `assets/${filename}`, format: "aiff", durationSeconds });
        segments.push({ id: segmentId, shotId: shot.id, role: input.role, ...(input.speaker ? { speaker: input.speaker } : {}), text: input.text, startSeconds: cursor, endSeconds: cursor + durationSeconds, durationSeconds, audioAssetId: assetId });
        cursor += durationSeconds;
      }
    }
  }
  const base = { schemaVersion: "0.1" as const, episodeId: spec.episode.id, sourceSpecVersion: spec.specVersion, generatedAt };
  return {
    manifest: { ...base, provider: provider.name as "macos-say", assets },
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
    return measureAudioDurationDefault(outputPath);
  }
};

