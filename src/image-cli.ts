import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateAndPublishVisualAsset } from "./image.ts";
import { getImageProvider } from "./image-providers.ts";
import type { AssetManifest, SeriesBible, ShotVisualSpec } from "./types.ts";

try {
  const [visualSpecPath, manifestPath, assetId, ...options] = process.argv.slice(2);
  if (!visualSpecPath || !manifestPath || !assetId) usage();
  if (!options.includes("--overwrite-manifest")) throw new Error("Generation requires --overwrite-manifest to publish the next manifest revision.");
  const providerName = optionValue(options, "--provider");
  const seriesBiblePath = optionValue(options, "--series-bible");
  if (!providerName) throw new Error("Generation requires --provider. Choose one of: fake, openai.");
  const spec = await readJson<ShotVisualSpec>(resolve(visualSpecPath), "ShotVisualSpec");
  const manifestFile = resolve(manifestPath);
  const manifest = await readJson<AssetManifest>(manifestFile, "AssetManifest");
  const seriesBible = seriesBiblePath ? await readJson<SeriesBible>(resolve(seriesBiblePath), "SeriesBible") : undefined;
  const assetDirectory = resolve(dirname(manifestFile), "assets");
  const next = await generateAndPublishVisualAsset(spec, manifest, assetId, { outputDirectory: assetDirectory, manifestPath: manifestFile, provider: getImageProvider(providerName), seriesBible });
  console.log(`IMAGE_GENERATION_COMPLETE: ${assetId} -> ${next.assets.find(asset => asset.id === assetId)?.activeVersionId}`);
} catch (cause) {
  console.error(`ERROR: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 2;
}

function usage(): never { throw new Error("Usage: npm run visual-generate -- <shot_visual_spec.json> <asset_manifest.json> <asset-id> --provider <fake|openai> [--series-bible series_bible.json] --overwrite-manifest"); }
function optionValue(options: string[], name: string): string | undefined { const index = options.indexOf(name); return index >= 0 ? options[index + 1] : undefined; }
async function readJson<T>(path: string, label: string): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (cause) { throw new Error(`${label} could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); } }
