/**
 * V0.8 Phase 1 — Asset Integrity Types
 *
 * IntegrityReport separates deterministic per-asset results from
 * execution metadata (checkedAt). The asset results themselves are
 * fully determined by the inputs (composition, manifests, filesystem);
 * checkedAt is recording when the check ran, not part of the result.
 */

export type AssetIntegrityStatus =
  | "OK"
  | "MISSING"
  | "HASH_MISMATCH"
  | "FORMAT_MISMATCH"
  | "BYTE_LENGTH_MISMATCH"
  | "PATH_VIOLATION"
  | "MANIFEST_REFERENCE_MISMATCH";

export interface VisualAssetIntegrityResult {
  kind: "visual";
  /** AssetManifest asset ID */
  assetId: string;
  /** AssetManifest version ID */
  assetVersionId: string;
  /** Path as declared in the composition/manifest */
  path: string;
  /** Absolute resolved path used for filesystem checks */
  resolvedPath: string;
  status: AssetIntegrityStatus;
  detail?: string;
  expectedSha256?: string;
  actualSha256?: string;
  expectedByteLength?: number;
  actualByteLength?: number;
}

export interface AudioAssetIntegrityResult {
  kind: "audio";
  /** AudioAssetManifest asset ID */
  assetId: string;
  /** Path as declared in the composition/manifest */
  path: string;
  /** Absolute resolved path used for filesystem checks */
  resolvedPath: string;
  status: AssetIntegrityStatus;
  detail?: string;
  /** SHA-256 of the file as found on disk. Informational only —
   *  no baseline hash is stored in AudioAssetManifest.
   *  Full audio integrity (duration, hash baseline) requires FFprobe (Phase 3). */
  actualSha256?: string;
  actualByteLength?: number;
}

export type AssetIntegrityResult = VisualAssetIntegrityResult | AudioAssetIntegrityResult;

/**
 * The deterministic portion of the report — fully determined by inputs.
 * checkedAt is execution metadata recorded separately.
 */
export interface IntegrityResults {
  status: "OK" | "FAILED";
  episodeId: string;
  compositionVersion: number;
  compositionSourceHash?: string;
  assets: AssetIntegrityResult[];
  failures: AssetIntegrityResult[];
}

/**
 * Full integrity report including execution metadata.
 * Do not use checkedAt as an input to downstream deterministic checks.
 */
export interface IntegrityReport extends IntegrityResults {
  /** ISO 8601 timestamp of when the check was executed — execution metadata only. */
  checkedAt: string;
}
