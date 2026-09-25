import { createHash } from "node:crypto";
import type { ApprovalRecord, PublishingPackage } from "./approval-types.ts";
import { canonicalJson } from "./orchestrator-state.ts";

function packageHash(input: PublishingPackage): string {
  const { contentHash: _contentHash, lifecycle: _lifecycle, ...immutable } = input;
  return createHash("sha256").update(canonicalJson(immutable)).digest("hex");
}

export function createPublishingPackage(input: Omit<PublishingPackage, "contentHash" | "lifecycle">): PublishingPackage {
  const draft = { ...input, contentHash: "", lifecycle: "READY_FOR_REVIEW" as const };
  return { ...draft, contentHash: packageHash(draft) };
}

export function approvePublishingPackage(
  publishingPackage: PublishingPackage,
  approval: Omit<ApprovalRecord, "packageId" | "packageHash" | "schemaVersion">
): ApprovalRecord {
  if (publishingPackage.lifecycle !== "READY_FOR_REVIEW") {
    throw new Error(`Only READY_FOR_REVIEW packages can be approved; received ${publishingPackage.lifecycle}.`);
  }
  assertPublishingPackageIntegrity(publishingPackage);
  return {
    schemaVersion: "0.1",
    packageId: publishingPackage.packageId,
    packageHash: packageHash(publishingPackage),
    ...approval,
  };
}

export function assertPublishingPackageIntegrity(publishingPackage: PublishingPackage): void {
  if (publishingPackage.contentHash !== packageHash(publishingPackage)) {
    throw new Error("Publishing package changed after it was created.");
  }
}

export function assertPublishAllowed(
  publishingPackage: PublishingPackage,
  approval?: ApprovalRecord
): void {
  assertPublishingPackageIntegrity(publishingPackage);
  if (!approval) throw new Error("Founder approval is required before publishing.");
  if (approval.packageId !== publishingPackage.packageId || approval.packageHash !== packageHash(publishingPackage)) {
    throw new Error("Founder approval does not match this immutable publishing package.");
  }
  if (publishingPackage.rightsEvidence.some(e => e.licenseStatus !== "CLEARED" || e.approvalStatus !== "APPROVED")) {
    throw new Error("Publishing package contains uncleared or unapproved rights evidence.");
  }
}
