/**
 * V0.8 Phase 1 — Asset Integrity Verification
 *
 * Two-layer check:
 *   Layer 1: FinalCompositionSpec references == AssetManifest active version
 *   Layer 2: AssetManifest active version == filesystem (existence, format, byteLength, SHA-256)
 *
 * Audio assets are checked via AudioAssetManifest for path/format/metadata,
 * then against the filesystem for existence and format.
 * Audio SHA-256 is computed and recorded but cannot be verified (no baseline
 * in AudioAssetManifest). Audio duration verification is deferred to Phase 3
 * (requires FFprobe).
 *
 * No FFmpeg. No rendering. No MP4. No fake duration calculations.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import type { AudioAssetManifest, AssetManifest, FinalCompositionSpec } from "./types.ts";
import type {
  AssetIntegrityResult,
  AudioAssetIntegrityResult,
  IntegrityReport,
  VisualAssetIntegrityResult,
} from "./integrity-types.ts";

export type { IntegrityReport, IntegrityResults, AssetIntegrityResult } from "./integrity-types.ts";

export interface IntegrityOptions {
  /** Overrides the checkedAt timestamp (useful in tests for stable snapshots). */
  checkedAt?: Date;
}

/**
 * Verify that all assets referenced by a FinalCompositionSpec:
 *  1. Are consistent with the AssetManifest / AudioAssetManifest records
 *  2. Exist on the filesystem within the declared assetRoot
 *  3. Have the correct format, byte length, and SHA-256 (visual assets)
 *
 * Audio duration is NOT verified here — deferred to Phase 3 (FFprobe).
 * Audio SHA-256 is computed and recorded but no manifest baseline exists.
 *
 * Returns an IntegrityReport. Does not throw on asset failures —
 * all failures are captured in the report. Throws only for invalid inputs
 * (malformed composition/manifests) that prevent the check from running.
 */
export async function verifyAssetIntegrity(
  composition: FinalCompositionSpec,
  audioManifest: AudioAssetManifest,
  assetManifest: AssetManifest,
  assetRoot: string,
  options: IntegrityOptions = {}
): Promise<IntegrityReport> {
  assertIntegrityInputs(composition, audioManifest, assetManifest, assetRoot);

  const normalizedRoot = normalizeRoot(assetRoot);
  const results: AssetIntegrityResult[] = [];

  // --- Visual assets ---
  const manifestAssetById = new Map(
    assetManifest.assets.map(a => [a.id, a])
  );

  for (const shot of composition.visualComposition.shots) {
    const result = await checkVisualAsset(shot.visualAsset, manifestAssetById, normalizedRoot);
    results.push(result);
  }

  // --- Audio assets ---
  const audioAssetById = new Map(
    audioManifest.assets.map(a => [a.id, a])
  );

  for (const track of composition.narrationDialogueTracks) {
    const result = await checkAudioAsset(track, audioAssetById, normalizedRoot);
    results.push(result);
  }

  for (const cue of composition.musicCues ?? []) {
    if (cue.audioAssetId && cue.path && cue.format) {
      const result = await checkAudioAsset(
        { audioAssetId: cue.audioAssetId, path: cue.path, format: cue.format, durationSeconds: cue.durationSeconds ?? (cue.endSeconds - cue.startSeconds) },
        audioAssetById,
        normalizedRoot
      );
      results.push(result);
    }
  }

  for (const cue of composition.sfxCues ?? []) {
    if (cue.audioAssetId && cue.path && cue.format) {
      const result = await checkAudioAsset(
        { audioAssetId: cue.audioAssetId, path: cue.path, format: cue.format, durationSeconds: cue.durationSeconds ?? (cue.endSeconds - cue.startSeconds) },
        audioAssetById,
        normalizedRoot
      );
      results.push(result);
    }
  }

  const failures = results.filter(r => r.status !== "OK");

  return {
    status: failures.length === 0 ? "OK" : "FAILED",
    episodeId: composition.episodeId,
    compositionVersion: composition.compositionVersion,
    compositionSourceHash: composition.sourceHash,
    checkedAt: (options.checkedAt ?? new Date()).toISOString(),
    assets: results,
    failures,
  };
}

// ---------------------------------------------------------------------------
// Visual asset check
// ---------------------------------------------------------------------------

async function checkVisualAsset(
  visualAsset: { assetId: string; assetVersionId: string; path: string; sha256: string },
  manifestAssetById: Map<string, AssetManifest["assets"][number]>,
  normalizedRoot: string
): Promise<VisualAssetIntegrityResult> {
  const base: Pick<VisualAssetIntegrityResult, "kind" | "assetId" | "assetVersionId" | "path"> = {
    kind: "visual",
    assetId: visualAsset.assetId,
    assetVersionId: visualAsset.assetVersionId,
    path: visualAsset.path,
  };

  // --- Layer 1: CompositionSpec reference == AssetManifest active version ---
  const manifestAsset = manifestAssetById.get(visualAsset.assetId);
  if (!manifestAsset) {
    return { ...base, resolvedPath: "", status: "MANIFEST_REFERENCE_MISMATCH", detail: `AssetManifest has no asset with id '${visualAsset.assetId}'.` };
  }
  const activeVersion = manifestAsset.versions.find(v => v.id === visualAsset.assetVersionId);
  if (!activeVersion?.output) {
    return { ...base, resolvedPath: "", status: "MANIFEST_REFERENCE_MISMATCH", detail: `AssetManifest has no GENERATED output for version '${visualAsset.assetVersionId}'.` };
  }
  if (activeVersion.output.path !== visualAsset.path) {
    return { ...base, resolvedPath: "", status: "MANIFEST_REFERENCE_MISMATCH", detail: `Composition path '${visualAsset.path}' does not match AssetManifest path '${activeVersion.output.path}'.` };
  }
  if (activeVersion.output.sha256 !== visualAsset.sha256) {
    return { ...base, resolvedPath: "", status: "MANIFEST_REFERENCE_MISMATCH", detail: `Composition sha256 does not match AssetManifest sha256 for version '${visualAsset.assetVersionId}'.` };
  }

  // The canonical values from the manifest (authoritative for Layer 2 checks)
  const expectedSha256 = activeVersion.output.sha256;
  const expectedByteLength = activeVersion.output.byteLength;

  // --- Path boundary check ---
  const resolvedPath = resolvePath(normalizedRoot, visualAsset.path);
  if (!isWithinRoot(resolvedPath, normalizedRoot)) {
    return { ...base, resolvedPath, status: "PATH_VIOLATION", detail: `Path resolves outside asset root: ${resolvedPath}` };
  }

  // --- Layer 2: AssetManifest == filesystem ---

  // Existence
  try { await access(resolvedPath); }
  catch { return { ...base, resolvedPath, status: "MISSING", detail: `File not found: ${resolvedPath}`, expectedSha256, expectedByteLength }; }

  // Format
  if (!resolvedPath.toLowerCase().endsWith(".png")) {
    return { ...base, resolvedPath, status: "FORMAT_MISMATCH", detail: `Expected .png extension, got: ${resolvedPath}`, expectedSha256, expectedByteLength };
  }

  // Byte length
  const fileStat = await stat(resolvedPath);
  const actualByteLength = fileStat.size;
  if (actualByteLength !== expectedByteLength) {
    return { ...base, resolvedPath, status: "BYTE_LENGTH_MISMATCH", detail: `Expected ${expectedByteLength} bytes, got ${actualByteLength}.`, expectedSha256, expectedByteLength, actualByteLength };
  }

  // SHA-256
  const actualSha256 = await computeSha256(resolvedPath);
  if (actualSha256 !== expectedSha256) {
    return { ...base, resolvedPath, status: "HASH_MISMATCH", detail: `SHA-256 mismatch for ${resolvedPath}.`, expectedSha256, actualSha256, expectedByteLength, actualByteLength };
  }

  return { ...base, resolvedPath, status: "OK", expectedSha256, actualSha256, expectedByteLength, actualByteLength };
}

// ---------------------------------------------------------------------------
// Audio asset check
// ---------------------------------------------------------------------------

async function checkAudioAsset(
  track: FinalCompositionSpec["narrationDialogueTracks"][number],
  audioAssetById: Map<string, AudioAssetManifest["assets"][number]>,
  normalizedRoot: string
): Promise<AudioAssetIntegrityResult> {
  const base: Pick<AudioAssetIntegrityResult, "kind" | "assetId" | "path"> = {
    kind: "audio",
    assetId: track.audioAssetId,
    path: track.path,
  };

  // --- Layer 1: CompositionSpec reference == AudioAssetManifest record ---
  const manifestAsset = audioAssetById.get(track.audioAssetId);
  if (!manifestAsset) {
    return { ...base, resolvedPath: "", status: "MANIFEST_REFERENCE_MISMATCH", detail: `AudioAssetManifest has no asset with id '${track.audioAssetId}'.` };
  }
  if (manifestAsset.path !== track.path) {
    return { ...base, resolvedPath: "", status: "MANIFEST_REFERENCE_MISMATCH", detail: `Composition path '${track.path}' does not match AudioAssetManifest path '${manifestAsset.path}'.` };
  }
  if (manifestAsset.format !== track.format) {
    return { ...base, resolvedPath: "", status: "MANIFEST_REFERENCE_MISMATCH", detail: `Composition format '${track.format}' does not match AudioAssetManifest format '${manifestAsset.format}'.` };
  }
  if (manifestAsset.durationSeconds !== track.durationSeconds) {
    return { ...base, resolvedPath: "", status: "MANIFEST_REFERENCE_MISMATCH", detail: `Composition durationSeconds ${track.durationSeconds} does not match AudioAssetManifest durationSeconds ${manifestAsset.durationSeconds}.` };
  }

  // --- Path boundary check ---
  const resolvedPath = resolvePath(normalizedRoot, track.path);
  if (!isWithinRoot(resolvedPath, normalizedRoot)) {
    return { ...base, resolvedPath, status: "PATH_VIOLATION", detail: `Path resolves outside asset root: ${resolvedPath}` };
  }

  // --- Layer 2: AudioAssetManifest → filesystem ---

  // Existence
  try { await access(resolvedPath); }
  catch { return { ...base, resolvedPath, status: "MISSING", detail: `File not found: ${resolvedPath}` }; }

  // Format (extension)
  if (!resolvedPath.toLowerCase().endsWith(".aiff")) {
    return { ...base, resolvedPath, status: "FORMAT_MISMATCH", detail: `Expected .aiff extension, got: ${resolvedPath}` };
  }

  // Byte length (informational; no baseline stored in AudioAssetManifest)
  const fileStat = await stat(resolvedPath);
  const actualByteLength = fileStat.size;

  // SHA-256 (computed and recorded; no baseline to compare — verification deferred to Phase 3)
  const actualSha256 = await computeSha256(resolvedPath);

  return { ...base, resolvedPath, status: "OK", actualSha256, actualByteLength };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeRoot(assetRoot: string): string {
  const abs = normalize(resolve(assetRoot));
  return abs.endsWith("/") ? abs : abs + "/";
}

function resolvePath(normalizedRoot: string, relativePath: string): string {
  // Resolve the path relative to the root (strip leading slash if present to avoid absolute override)
  const sanitized = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  return normalize(resolve(normalizedRoot, sanitized));
}

function isWithinRoot(resolvedPath: string, normalizedRoot: string): boolean {
  const normalized = resolvedPath.endsWith("/") ? resolvedPath : resolvedPath + "/";
  return normalized.startsWith(normalizedRoot) || resolvedPath + "/" === normalizedRoot;
}

async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function assertIntegrityInputs(
  composition: unknown,
  audioManifest: unknown,
  assetManifest: unknown,
  assetRoot: unknown
): asserts composition is FinalCompositionSpec {
  if (!composition || typeof composition !== "object") throw new Error("verifyAssetIntegrity requires a FinalCompositionSpec object.");
  const c = composition as Partial<FinalCompositionSpec>;
  if (!c.episodeId || typeof c.compositionVersion !== "number" || !c.visualComposition || !Array.isArray(c.visualComposition.shots) || !Array.isArray(c.narrationDialogueTracks)) {
    throw new Error("FinalCompositionSpec is missing required fields for integrity verification.");
  }
  if (!audioManifest || typeof audioManifest !== "object" || !Array.isArray((audioManifest as any).assets)) {
    throw new Error("verifyAssetIntegrity requires an AudioAssetManifest with an assets array.");
  }
  if (!assetManifest || typeof assetManifest !== "object" || !Array.isArray((assetManifest as any).assets)) {
    throw new Error("verifyAssetIntegrity requires an AssetManifest with an assets array.");
  }
  if (typeof assetRoot !== "string" || assetRoot.trim().length === 0) {
    throw new Error("verifyAssetIntegrity requires a non-empty assetRoot string.");
  }
}
