/**
 * V0.8 Phase 2 — Renderer Abstraction
 *
 * Defines the Renderer interface and the precondition guard used by all
 * concrete renderer implementations.
 *
 * Phase 3 introduces FFmpegRenderer (src/ffmpeg-renderer.ts) which
 * implements Renderer without changing this file or its callers.
 *
 * The renderer is NOT responsible for:
 *   - integrity verification (src/integrity.ts)
 *   - composition planning (src/postproduction.ts)
 *   - asset generation (src/image.ts / src/visual.ts)
 *   - editorial decisions of any kind
 *
 * The renderer IS responsible for:
 *   - enforcing the integrity precondition before rendering
 *   - translating FinalCompositionSpec → encoding instructions
 *   - executing the encoding process
 *   - reporting a typed RenderResult
 *   - cleaning up any staging output on failure
 */

import { normalize, resolve } from "node:path";
import type { FinalCompositionSpec } from "./types.ts";
import { RenderError } from "./renderer-types.ts";
import type { RenderContext, RenderResult } from "./renderer-types.ts";
import type { AssetIntegrityResult } from "./integrity-types.ts";

export type { RenderContext, RenderResult, RenderSuccess, RenderFailure, RenderError } from "./renderer-types.ts";

/**
 * The renderer interface.
 *
 * Callers must:
 * 1. Run verifyAssetIntegrity() and confirm status === "OK".
 * 2. Pass the IntegrityReport inside RenderContext.
 * 3. Call render() with a validated FinalCompositionSpec.
 *
 * render() throws RenderError for precondition violations.
 * render() returns RenderFailure for failures during encoding itself.
 */
export interface Renderer {
  /**
   * Render a validated FinalCompositionSpec to a media file.
   *
   * @throws RenderError if preconditions are not met (invalid inputs,
   *   failed/missing integrity report, bad output path).
   * @returns RenderResult — OK with output metadata, or FAILED with reason.
   */
  render(composition: FinalCompositionSpec, context: RenderContext): Promise<RenderResult>;

  /** Human-readable renderer identifier (e.g. "FFmpegRenderer/6.1"). */
  readonly rendererVersion: string;
}

/**
 * assertRenderPreconditions — enforced by all Renderer implementations
 * before doing any encoding work.
 *
 * Exported so concrete renderer implementations can call it as the first
 * step in render(), keeping the precondition logic canonical and testable.
 *
 * Throws RenderError on any violation.
 */
export function assertRenderPreconditions(
  composition: unknown,
  context: unknown
): asserts composition is FinalCompositionSpec {
  // -- composition --
  if (!composition || typeof composition !== "object") {
    throw new RenderError("Renderer requires a FinalCompositionSpec object.");
  }
  const c = composition as Partial<FinalCompositionSpec>;
  if (
    !c.episodeId ||
    typeof c.compositionVersion !== "number" ||
    !c.visualComposition ||
    !Array.isArray(c.visualComposition.shots) ||
    !Array.isArray(c.narrationDialogueTracks) ||
    typeof c.durationSeconds !== "number"
  ) {
    throw new RenderError("FinalCompositionSpec is missing required fields for rendering.");
  }

  // -- context --
  if (!context || typeof context !== "object") {
    throw new RenderError("Renderer requires a RenderContext object.");
  }
  const ctx = context as Partial<RenderContext>;

  if (typeof ctx.assetRoot !== "string" || ctx.assetRoot.trim().length === 0) {
    throw new RenderError("RenderContext.assetRoot must be a non-empty string.");
  }
  if (typeof ctx.outputPath !== "string" || ctx.outputPath.trim().length === 0) {
    throw new RenderError("RenderContext.outputPath must be a non-empty string.");
  }

  // Output boundary check
  const normalizedOutput = normalize(resolve(ctx.outputPath));
  if (!normalizedOutput.toLowerCase().endsWith(".mp4")) {
    throw new RenderError(`RenderContext.outputPath must have a .mp4 extension, got: '${ctx.outputPath}'.`);
  }

  // -- integrity gate --
  if (!ctx.integrityReport || typeof ctx.integrityReport !== "object") {
    throw new RenderError("RenderContext.integrityReport is required. Run verifyAssetIntegrity() first.");
  }
  const report = ctx.integrityReport as any;
  if (report.status !== "OK") {
    throw new RenderError(
      `Renderer refuses to render: integrity report status is '${report.status}'. ` +
      "All assets must pass Phase 1 integrity verification before rendering."
    );
  }
  if (report.episodeId !== c.episodeId) {
    throw new RenderError(
      `Renderer refuses to render: integrity report episodeId '${report.episodeId}' ` +
      `does not match composition episodeId '${c.episodeId}'.`
    );
  }
  if (report.compositionVersion !== c.compositionVersion) {
    throw new RenderError(
      `Renderer refuses to render: integrity report compositionVersion ` +
      `'${report.compositionVersion}' does not match ` +
      `composition compositionVersion '${c.compositionVersion}'.`
    );
  }

  // 1. Composition source binding
  if (report.compositionSourceHash && report.compositionSourceHash !== c.sourceHash) {
    throw new RenderError(
      `Renderer refuses to render: integrity report compositionSourceHash ` +
      `'${report.compositionSourceHash}' does not match ` +
      `composition sourceHash '${c.sourceHash}'.`
    );
  }

  // 2. Asset-level binding
  const reportAssets: AssetIntegrityResult[] = Array.isArray(report.assets) ? report.assets : [];
  
  // Check visual assets
  for (const shot of c.visualComposition.shots) {
    const vAsset = shot.visualAsset;
    const matched = reportAssets.find(
      (a) =>
        a.kind === "visual" &&
        a.assetId === vAsset.assetId &&
        a.assetVersionId === vAsset.assetVersionId &&
        a.status === "OK"
    );
    if (!matched) {
      throw new RenderError(
        `Renderer refuses to render: visual asset '${vAsset.assetId}' (version '${vAsset.assetVersionId}') ` +
        `has no OK integrity report result.`
      );
    }
  }

  // Check audio assets
  for (const track of c.narrationDialogueTracks) {
    const matched = reportAssets.find(
      (a) => a.kind === "audio" && a.assetId === track.audioAssetId && a.status === "OK"
    );
    if (!matched) {
      throw new RenderError(
        `Renderer refuses to render: audio asset '${track.audioAssetId}' has no OK integrity report result.`
      );
    }
  }
}
