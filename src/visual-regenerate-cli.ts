import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { regenerateVisualAsset } from "./visual.ts";
import type { AssetManifest } from "./types.ts";

try {
  const [manifestPath, assetId, ...options] = process.argv.slice(2);
  if (!manifestPath || !assetId) throw new Error("Usage: npm run visual-regenerate -- <asset_manifest.json> <asset-id> [--overwrite]");
  if (!options.includes("--overwrite")) throw new Error("Regeneration requires --overwrite to replace the manifest with its next immutable revision.");
  const path = resolve(manifestPath);
  const manifest = JSON.parse(await readFile(path, "utf8")) as AssetManifest;
  const next = regenerateVisualAsset(manifest, assetId);
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`VISUAL_REGENERATION_PLANNED: ${assetId} -> ${next.assets.find(asset => asset.id === assetId)?.activeVersionId}`);
} catch (cause) {
  console.error(`ERROR: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exitCode = 2;
}
