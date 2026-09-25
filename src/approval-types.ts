/** Founder approval and publishing governance contracts. */

export type EpisodeLifecycle =
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "APPROVED"
  | "PUBLISHED";

export type RightsStatus = "UNKNOWN" | "CLEARED" | "RESTRICTED";

export interface RightsEvidence {
  assetId: string;
  provider: string;
  sourceReference?: string;
  generatedAt: string;
  licenseStatus: RightsStatus;
  attribution?: string;
  approvalStatus: "PENDING" | "APPROVED" | "REJECTED";
}

export interface PublishingPackage {
  schemaVersion: "0.1";
  packageId: string;
  episodeId: string;
  runId: string;
  videoOutputPath: string;
  thumbnailPath?: string;
  title: string;
  description: string;
  captionsPath?: string;
  visibility: "private" | "unlisted" | "public";
  publishAt?: string;
  qcReportHash?: string;
  repairReportHash?: string;
  rightsEvidence: RightsEvidence[];
  contentHash: string;
  lifecycle: EpisodeLifecycle;
}

export interface ApprovalRecord {
  schemaVersion: "0.1";
  packageId: string;
  packageHash: string;
  approvedBy: string;
  approvedAt: string;
  action: "APPROVE_AND_PUBLISH" | "APPROVE_FOR_SCHEDULE";
}
