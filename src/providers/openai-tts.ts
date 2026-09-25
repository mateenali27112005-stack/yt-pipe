import { access, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname } from "node:path";
import { promisify } from "node:util";
import type { SpeechProvider } from "../audio.ts";

const execFileAsync = promisify(execFile);

export interface OpenAiSpeechConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  voiceMap?: Record<string, string>;
  responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  fetchImpl?: typeof fetch;
  measureDuration?: (outputPath: string) => Promise<number>;
}

export function createOpenAiSpeechProvider(options: OpenAiSpeechConfig = {}): SpeechProvider {
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
