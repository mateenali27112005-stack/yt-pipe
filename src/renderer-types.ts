/**
 * V0.8 Phase 2 — Renderer Types
 *
 * These types form the stable contract between:
 *   - the domain layer (FinalCompositionSpec, IntegrityReport)
 *   - the renderer abstraction (Renderer interface)
 *   - the rendering output (RenderResult)
 *
 * Phase 3 (FFmpegRenderer) implements Renderer without changing these types.
 * Callers never import FFmpeg-specific code through this interface.
 */

import type { IntegrityReport } from "./integrity-types.ts";

/**
 * Context required by the renderer.
 *
 * - assetRoot: the filesystem root used during Phase 1 integrity check.
 *   All asset paths in the composition are resolved relative to this.
 * - outputPath: where the renderer should write the final MP4.
 *   Must be an absolute path. The renderer will NOT publish to this
 *   path until rendering is complete and verified (transactional, Phase 4).
 * - integrityReport: a completed integrity report from Phase 1.
 *   Must have status "OK". The renderer will refuse to proceed otherwise.
 *   The caller is responsible for running verifyAssetIntegrity() first.
 */
export interface RenderContext {
  assetRoot: string;
  outputPath: string;
  integrityReport: IntegrityReport;
}

/**
 * A successful render result.
 *
 * durationSeconds is ONLY populated when the renderer has actually measured
 * the output (e.g. via ffprobe in Phase 3). It must never be assumed from
 * the composition's declared durationSeconds.
 *
 * sha256 and byteLength are computed from the actual output file.
 */
export interface RenderSuccess {
  status: "OK";
  outputPath: string;
  format: string;
  byteLength: number;
  sha256: string;
  /** Measured output duration. Absent if the renderer cannot determine it. */
  durationSeconds?: number;
  /** Renderer implementation identity — version + name. */
  rendererVersion: string;
}

/**
 * A failed render result.
 *
 * The renderer must never publish partial output after a failure.
 * Any staging output is the renderer's responsibility to clean up.
 */
export interface RenderFailure {
  status: "FAILED";
  reason: string;
  /** Optional — present when the failure has a recoverable/diagnostic cause. */
  cause?: Error;
}

export type RenderResult = RenderSuccess | RenderFailure;

/**
 * Thrown for precondition violations that prevent rendering from starting —
 * invalid composition, failed integrity report, invalid context fields, etc.
 * These are contract errors, not rendering failures.
 *
 * Use RenderFailure (not RenderError) for failures that happen during the
 * actual encoding process.
 */
export class RenderError extends Error {
  readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = "RenderError";
    this.cause = cause;
  }
}
