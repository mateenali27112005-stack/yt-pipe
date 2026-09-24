import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { assertAssetManifest } from "./visual.ts";
import type { AssetManifest, ShotVisualSpec } from "./types.ts";

export interface ImageProvider {
  name: string;
  generate(input: { prompt: string; outputFormat: "png" }): Promise<{ bytes: Uint8Array; model: string; revisedPrompt?: string }>;
}

export interface ImageGenerationOptions {
  outputDirectory: string;
  provider?: ImageProvider;
  generatedAt?: Date;
}

export interface ImagePublicationOptions extends ImageGenerationOptions {
  manifestPath: string;
  publishManifest?: (manifest: AssetManifest, path: string) => Promise<void>;
}

export async function generateVisualAsset(visualSpec: ShotVisualSpec, manifest: AssetManifest, assetId: string, options: ImageGenerationOptions): Promise<AssetManifest> {
  assertVisualGenerationInputs(visualSpec, manifest, assetId);
  const provider = options.provider ?? openAiImageProvider;
  const asset = manifest.assets.find(candidate => candidate.id === assetId)!;
  const shot = visualSpec.shots.find(candidate => candidate.id === asset.shotVisualSpecId)!;
  const prompt = buildImagePrompt(shot);
  const result = await provider.generate({ prompt, outputFormat: "png" });
  if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength === 0) throw new Error(`Image provider '${provider.name}' returned no image bytes.`);
  const createdAt = (options.generatedAt ?? new Date()).toISOString();
  const version = Math.max(...asset.versions.map(candidate => candidate.version)) + 1;
  const versionId = `${asset.id}_v${version}`;
  const filename = `${versionId}.png`;
  const outputDirectory = resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const finalPath = resolve(outputDirectory, filename);
  const temporaryPath = `${finalPath}.staging-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, result.bytes, { flag: "wx" });
    const file = await stat(temporaryPath);
    if (file.size !== result.bytes.byteLength) throw new Error(`Generated image size mismatch for ${versionId}.`);
    await rename(temporaryPath, finalPath);
  } catch (cause) {
    await rm(temporaryPath, { force: true });
    throw cause;
  }
  const assets = manifest.assets.map(candidate => candidate.id === assetId ? {
    ...candidate,
    activeVersionId: versionId,
    versions: [...candidate.versions, {
      id: versionId,
      version,
      lifecycle: "GENERATED" as const,
      createdAt,
      supersedesVersionId: candidate.activeVersionId,
      output: { path: `assets/${filename}`, format: "png" as const, byteLength: result.bytes.byteLength, sha256: hash(result.bytes) },
      provider: { name: provider.name, model: result.model, promptHash: hash(prompt), ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}) }
    }]
  } : candidate);
  const next = { ...manifest, manifestRevision: manifest.manifestRevision + 1, generatedAt: createdAt, assets };
  assertAssetManifest(next);
  return next;
}

export async function generateAndPublishVisualAsset(visualSpec: ShotVisualSpec, manifest: AssetManifest, assetId: string, options: ImagePublicationOptions): Promise<AssetManifest> {
  const next = await generateVisualAsset(visualSpec, manifest, assetId, options);
  const generatedAsset = next.assets.find(asset => asset.id === assetId);
  const activeVersion = generatedAsset?.versions.find(version => version.id === generatedAsset.activeVersionId);
  if (!activeVersion?.output) throw new Error(`Generated visual asset '${assetId}' has no published output metadata.`);
  const imagePath = resolve(options.outputDirectory, activeVersion.output.path.replace(/^assets\//, ""));
  try {
    await (options.publishManifest ?? publishManifestAtomically)(next, options.manifestPath);
    return next;
  } catch (cause) {
    await rm(imagePath, { force: true });
    throw cause;
  }
}

export function buildImagePrompt(shot: ShotVisualSpec["shots"][number]): string {
  return [
    "Use case: illustration-story",
    "Asset type: cinematic motion-comic shot",
    `Primary request: ${shot.visualIntent}`,
    `Action: ${shot.action}`,
    `Framing: ${shot.framing}`,
    `Expression: ${shot.expression}`,
    `Lighting and mood: ${shot.lighting}; ${shot.mood}`,
    `Camera intent: ${shot.cameraIntent}`,
    `Style reference: ${shot.styleReference}`,
    "Constraints: coherent character identity and location continuity; no text, captions, logos, or watermarks"
  ].join("\n");
}

export function assertVisualGenerationInputs(visualSpec: unknown, manifest: unknown, assetId: string): asserts visualSpec is ShotVisualSpec & { visualSpecVersion: number } {
  if (!visualSpec || typeof visualSpec !== "object") throw new Error("Image generation requires a ShotVisualSpec JSON object.");
  const spec = visualSpec as Partial<ShotVisualSpec>;
  if (spec.schemaVersion !== "0.1" || !Number.isInteger(spec.visualSpecVersion) || (spec.visualSpecVersion ?? 0) < 1 || !Array.isArray(spec.shots)) throw new Error("ShotVisualSpec is missing required fields.");
  assertAssetManifest(manifest);
  const assets = manifest as AssetManifest;
  if (assets.episodeId !== spec.episodeId || assets.sourceSpecVersion !== spec.sourceSpecVersion || assets.sourceVisualSpecVersion !== spec.visualSpecVersion) throw new Error("AssetManifest does not match the ShotVisualSpec provenance.");
  const asset = assets.assets.find(candidate => candidate.id === assetId);
  if (!asset) throw new Error(`Visual asset '${assetId}' does not exist in the manifest.`);
  if (!spec.shots.some(shot => shot.id === asset.shotVisualSpecId && shot.shotId === asset.shotId)) throw new Error(`Visual asset '${assetId}' does not resolve to a ShotVisualSpec.`);
}

export const openAiImageProvider: ImageProvider = {
  name: "openai-images",
  async generate(input) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for the OpenAI image provider. Set it locally before running visual generation.");
    const response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2.5-flare", prompt: input.prompt, n: 1, size: "1536x1024", quality: "medium", output_format: input.outputFormat })
    });
    const payload = await response.json() as { data?: Array<{ b64_json?: string; revised_prompt?: string }>; error?: { message?: string } };
    if (!response.ok) throw new Error(`OpenAI image generation failed: ${payload.error?.message ?? response.statusText}`);
    const image = payload.data?.[0];
    if (!image?.b64_json) throw new Error("OpenAI image generation returned no base64 image data.");
    return { bytes: Buffer.from(image.b64_json, "base64"), model: "gpt-image-2.5-flare", ...(image.revised_prompt ? { revisedPrompt: image.revised_prompt } : {}) };
  }
};

async function publishManifestAtomically(manifest: AssetManifest, manifestPath: string): Promise<void> {
  const destination = resolve(manifestPath);
  await mkdir(dirname(destination), { recursive: true });
  const stagingPath = `${destination}.staging-${process.pid}-${Date.now()}`;
  try {
    await writeFile(stagingPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(stagingPath, destination);
  } catch (cause) {
    await rm(stagingPath, { force: true });
    throw cause;
  }
}

function hash(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
