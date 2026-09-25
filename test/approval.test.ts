import assert from "node:assert/strict";
import test from "node:test";
import {
  approvePublishingPackage,
  assertPublishAllowed,
  assertPublishingPackageIntegrity,
  createPublishingPackage,
} from "../src/approval.ts";

function makePackage() {
  return createPublishingPackage({
    schemaVersion: "0.1",
    packageId: "run_1:EP_1",
    episodeId: "EP_1",
    runId: "run_1",
    videoOutputPath: "/tmp/output.mp4",
    title: "The Test",
    description: "A test episode",
    visibility: "private",
    rightsEvidence: [{
      assetId: "shot_1",
      provider: "openai",
      generatedAt: "2026-09-26T00:00:00.000Z",
      licenseStatus: "CLEARED",
      approvalStatus: "APPROVED"
    }]
  });
}

test("publishing package is immutable and requires explicit founder approval", () => {
  const publishingPackage = makePackage();
  assert.equal(publishingPackage.lifecycle, "READY_FOR_REVIEW");
  assert.throws(() => assertPublishAllowed(publishingPackage), /Founder approval is required/);

  const approval = approvePublishingPackage(publishingPackage, {
    approvedBy: "founder",
    approvedAt: "2026-09-26T01:00:00.000Z",
    action: "APPROVE_AND_PUBLISH"
  });
  assert.doesNotThrow(() => assertPublishAllowed(publishingPackage, approval));
});

test("changing package metadata invalidates approval", () => {
  const publishingPackage = makePackage();
  const approval = approvePublishingPackage(publishingPackage, {
    approvedBy: "founder",
    approvedAt: "2026-09-26T01:00:00.000Z",
    action: "APPROVE_FOR_SCHEDULE"
  });
  const changed = { ...publishingPackage, title: "Changed after approval" };
  assert.throws(() => assertPublishingPackageIntegrity(changed), /changed after it was created/);
  assert.throws(() => assertPublishAllowed(changed, approval), /changed after it was created/);
});

test("uncleared rights prevent publishing even with founder approval", () => {
  const publishingPackage = createPublishingPackage({
    ...makePackage(),
    contentHash: undefined as never,
    lifecycle: undefined as never,
    rightsEvidence: [{
      assetId: "shot_1",
      provider: "unknown",
      generatedAt: "2026-09-26T00:00:00.000Z",
      licenseStatus: "UNKNOWN",
      approvalStatus: "PENDING"
    }]
  });
  const approval = approvePublishingPackage(publishingPackage, {
    approvedBy: "founder",
    approvedAt: "2026-09-26T01:00:00.000Z",
    action: "APPROVE_AND_PUBLISH"
  });
  assert.throws(() => assertPublishAllowed(publishingPackage, approval), /uncleared/);
});
