ALTER TABLE "JotformSubmission" ADD COLUMN "ownerUserId" TEXT, ADD COLUMN "ownershipVerifiedAt" TIMESTAMP(3), ADD COLUMN "ownershipVerifiedBy" TEXT;
CREATE INDEX "JotformSubmission_ownerUserId_idx" ON "JotformSubmission"("ownerUserId");
ALTER TABLE "JotformSubmission" ADD CONSTRAINT "JotformSubmission_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE TABLE "RevokedSession" ("tokenHash" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "RevokedSession_pkey" PRIMARY KEY ("tokenHash"));
CREATE INDEX "RevokedSession_expiresAt_idx" ON "RevokedSession"("expiresAt");
