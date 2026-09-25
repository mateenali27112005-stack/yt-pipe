import type { ImageProvider } from "../image.ts";

export interface OpenAiImageConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  size?: string;
  quality?: string;
  fetchImpl?: typeof fetch;
}

export function createOpenAiImageProvider(options: OpenAiImageConfig = {}): ImageProvider {
  return {
    name: "openai-images",
    async generate(input) {
      const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is required for the OpenAI image provider. Set it locally before running visual generation.");
      }
      const fetchFunc = options.fetchImpl ?? globalThis.fetch;
      if (typeof fetchFunc !== "function") {
        throw new Error("Global fetch is unavailable. Provide fetchImpl in options.");
      }
      const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
      const model = options.model ?? process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2.5-flare";
      const size = options.size ?? "1536x1024";
      const quality = options.quality ?? "medium";

      const response = await fetchFunc(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          prompt: input.prompt,
          n: 1,
          size,
          quality,
          output_format: input.outputFormat
        })
      });

      const payload = await response.json().catch(() => ({})) as {
        data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
        error?: { message?: string };
      };

      if (!response.ok) {
        throw new Error(`OpenAI image generation failed (${response.status}): ${payload.error?.message ?? response.statusText}`);
      }

      const image = payload.data?.[0];
      if (image?.b64_json) {
        return {
          bytes: Buffer.from(image.b64_json, "base64"),
          model,
          ...(image.revised_prompt ? { revisedPrompt: image.revised_prompt } : {})
        };
      } else if (image?.url) {
        const imageRes = await fetchFunc(image.url);
        if (!imageRes.ok) {
          throw new Error(`Failed to download generated image from OpenAI URL: ${imageRes.statusText}`);
        }
        const arrayBuf = await imageRes.arrayBuffer();
        return {
          bytes: new Uint8Array(arrayBuf),
          model,
          ...(image.revised_prompt ? { revisedPrompt: image.revised_prompt } : {})
        };
      }

      throw new Error("OpenAI image generation returned no image data (neither b64_json nor url).");
    }
  };
}

export const openAiImageProvider: ImageProvider = createOpenAiImageProvider();
