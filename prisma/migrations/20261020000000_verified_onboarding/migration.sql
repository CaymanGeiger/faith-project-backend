-- Existing accounts retain their current access pending explicit roster/policy review.
-- No legacy certification or enrollment status is treated as verified training.
ALTER TABLE "User" ADD COLUMN "onboardingRequired" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "activationSubmissionId" TEXT,
  ADD COLUMN "initialTrainingVerifiedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "User_activationSubmissionId_key" ON "User"("activationSubmissionId");
CREATE TABLE "InitialTrainingVerification" (
  "id" TEXT NOT NULL,
  "prospectUserId" TEXT NOT NULL,
  "verifiedByUserId" TEXT,
  "completedAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "enrollmentId" TEXT,
  CONSTRAINT "InitialTrainingVerification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InitialTrainingVerification_prospectUserId_fkey" FOREIGN KEY ("prospectUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InitialTrainingVerification_verifiedByUserId_fkey" FOREIGN KEY ("verifiedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "InitialTrainingVerification_prospectUserId_key" ON "InitialTrainingVerification"("prospectUserId");
