/**
 * V0.8 Phase 4 — Render Pipeline Orchestration
 *
 * Orchestrates the complete end-to-end rendering pipeline:
 *
 * FinalCompositionSpec JSON + AudioAssetManifest JSON + AssetManifest JSON
 *                           ↓
 *                 verifyAssetIntegrity()
 *                           ↓
 *                 IntegrityReport ("OK")
 *                           ↓
 *                     RenderContext
 *                           ↓
 *                  FFmpegRenderer.render()
 *                           ↓
 *                     RenderResult
 *
 * Safe transactional guarantees:
 *   - Fails closed at integrity boundary before calling renderer.
 *   - Protects existing target output unless overwrite flag is set.
 *   - Never mutates input objects or publishes partial output on failure.
 */

import { access, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

import type { AssetManifest, AudioAssetManifest, FinalCompositionSpec } from "./types.ts";
import { verifyAssetIntegrity } from "./integrity.ts";
import type { IntegrityReport } from "./integrity-types.ts";
import { assertRenderPreconditions, type Renderer } from "./renderer.ts";
import { RenderError } from "./renderer-types.ts";
import type { RenderContext, RenderResult } from "./renderer-types.ts";
import { FFmpegRenderer } from "./ffmpeg-renderer.ts";

export interface ExecuteRenderPipelineOptions {
  compositionPath: string;
  audioManifestPath: string;
  assetManifestPath: string;
  assetRoot: string;
  outputPath: string;
  overwrite?: boolean;
  /** Injectable renderer implementation (default: new FFmpegRenderer()) */
  renderer?: Renderer;
}

export interface ExecuteRenderPipelineResult {
  status: "OK" | "FAILED";
  episodeId: string;
  compositionVersion: number;
  composition: FinalCompositionSpec;
  integrityReport: IntegrityReport;
  renderResult: RenderResult;
  outputPath: string;
}

/**
 * Execute the V0.8 render pipeline programmatically.
 *
 * Throws RenderError for contract/precondition violations (bad paths, malformed JSON, overwrite violation).
 * Returns ExecuteRenderPipelineResult (status "OK" or "FAILED") for integrity/rendering failures.
 */
export async function executeRenderPipeline(
  options: ExecuteRenderPipelineOptions
): Promise<ExecuteRenderPipelineResult> {
  // 1. Path validation
  if (!options || typeof options !== "object") {
    throw new RenderError("executeRenderPipeline requires an options object.");
  }
  const { compositionPath, audioManifestPath, assetManifestPath, assetRoot, outputPath, overwrite } = options;

  if (!compositionPath || typeof compositionPath !== "string") throw new RenderError("options.compositionPath is required.");
  if (!audioManifestPath || typeof audioManifestPath !== "string") throw new RenderError("options.audioManifestPath is required.");
  if (!assetManifestPath || typeof assetManifestPath !== "string") throw new RenderError("options.assetManifestPath is required.");
  if (!assetRoot || typeof assetRoot !== "string") throw new RenderError("options.assetRoot is required.");
  if (!outputPath || typeof outputPath !== "string") throw new RenderError("options.outputPath is required.");

  const absAssetRoot = normalize(resolve(assetRoot));
  if (!isAbsolute(assetRoot)) {
    throw new RenderError(`options.assetRoot must be an absolute path, got: '${assetRoot}'.`);
  }

  const absOutputPath = normalize(resolve(outputPath));
  if (!isAbsolute(outputPath)) {
    throw new RenderError(`options.outputPath must be an absolute path, got: '${outputPath}'.`);
  }

  if (!absOutputPath.toLowerCase().endsWith(".mp4")) {
    throw new RenderError(`options.outputPath must have a .mp4 extension, got: '${outputPath}'.`);
  }

  // 2. Target output protection
  if (!overwrite) {
    let exists = false;
    try {
      await access(absOutputPath);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      throw new RenderError(
        `Output path '${absOutputPath}' already exists. Pass overwrite: true to allow replacing existing file.`
      );
    }
  }

  // Ensure output parent directory exists
  await mkdir(resolve(absOutputPath, ".."), { recursive: true });

  // 3. Read input JSON contracts
  const composition = await readJson<FinalCompositionSpec>(resolve(compositionPath), "FinalCompositionSpec");
  const audioManifest = await readJson<AudioAssetManifest>(resolve(audioManifestPath), "AudioAssetManifest");
  const assetManifest = await readJson<AssetManifest>(resolve(assetManifestPath), "AssetManifest");

  // 4. Run Phase 1 asset integrity check
  const integrityReport = await verifyAssetIntegrity(composition, audioManifest, assetManifest, absAssetRoot);

  // 5. Fail closed if integrity status is FAILED
  if (integrityReport.status !== "OK") {
    return {
      status: "FAILED",
      episodeId: composition.episodeId,
      compositionVersion: composition.compositionVersion,
      composition,
      integrityReport,
      renderResult: {
        status: "FAILED",
        reason: `Asset integrity check failed with ${integrityReport.failures.length} issue(s). Failsafe triggered before rendering.`,
      },
      outputPath: absOutputPath,
    };
  }

  // 6. Construct RenderContext & enforce preconditions
  const renderContext: RenderContext = {
    assetRoot: absAssetRoot,
    outputPath: absOutputPath,
    integrityReport,
  };

  const renderer = options.renderer ?? new FFmpegRenderer();
  assertRenderPreconditions(composition, renderContext);

  // 7. Render
  const renderResult = await renderer.render(composition, renderContext);

  return {
    status: renderResult.status === "OK" ? "OK" : "FAILED",
    episodeId: composition.episodeId,
    compositionVersion: composition.compositionVersion,
    composition,
    integrityReport,
    renderResult,
    outputPath: absOutputPath,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string, label: string): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: any) {
    throw new RenderError(`Failed to read or parse ${label} JSON at '${filePath}': ${err.message ?? err}`);
  }
}
