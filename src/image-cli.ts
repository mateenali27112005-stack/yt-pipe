import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateVisualAsset } from "./image.ts";
import type { AssetManifest, ShotVisualSpec } from "./types.ts";

try {
  const [visualSpecPath, manifestPath, assetId, ...options] = process.argv.slice(2);
  if (!visualSpecPath || !manifestPath || !assetId) usage();
  if (!options.includes("--overwrite-manifest")) throw new Error("Generation requires --overwrite-manifest to publish the next manifest revision.");
  const spec = await readJson<ShotVisualSpec>(resolve(visualSpecPath), "ShotVisualSpec");
  const manifestFile = resolve(manifestPath);
  const manifest = await readJson<AssetManifest>(manifestFile, "AssetManifest");
  const assetDirectory = resolve(dirname(manifestFile), "assets");
  const next = await generateVisualAsset(spec, manifest, assetId, { outputDirectory: assetDirectory });
  const stagingManifest = `${manifestFile}.staging-${process.pid}-${Date.now()}`;
  try {
    await writeFile(stagingManifest, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    await access(stagingManifest);
    await rename(stagingManifest, manifestFile);
  } catch (cause) {
    await rm(stagingManifest, { force: true });
    throw cause;
  }
  console.log(`IMAGE_GENERATION_COMPLETE: ${assetId} -> ${next.assets.find(asset => asset.id === assetId)?.activeVersionId}`);
} catch (cause) {
  console.error(`ERROR: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 2;
}

function usage(): never { throw new Error("Usage: npm run visual-generate -- <shot_visual_spec.json> <asset_manifest.json> <asset-id> --overwrite-manifest"); }
async function readJson<T>(path: string, label: string): Promise<T> { try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (cause) { throw new Error(`${label} could not be parsed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`); } }
