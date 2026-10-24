-- The Jotform webhook is only a notification. These records provide a durable,
-- idempotent inbox and store the minimal API-verified dealer-registration state.
CREATE TYPE "JotformSyncStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'RETRY_WAIT',
  'PROCESSED',
  'DEAD_LETTER',
  'REJECTED'
);

CREATE TYPE "JotformSyncSource" AS ENUM (
  'WEBHOOK',
  'RECONCILIATION',
  'MANUAL_REPLAY'
);

CREATE TABLE "JotformSubmission" (
  "id" TEXT NOT NULL,
  "formId" TEXT NOT NULL,
  "submissionId" TEXT NOT NULL,
  "lastEnqueuedBy" "JotformSyncSource" NOT NULL,
  "syncStatus" "JotformSyncStatus" NOT NULL DEFAULT 'PENDING',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "processingGeneration" INTEGER,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "firstWebhookReceivedAt" TIMESTAMP(3),
  "lastWebhookReceivedAt" TIMESTAMP(3),
  "webhookDeliveryCount" INTEGER NOT NULL DEFAULT 0,
  "envelopeFingerprint" TEXT,
  "vendorCreatedAt" TEXT,
  "vendorUpdatedAt" TEXT,
  "vendorStatus" TEXT,
  "workflowStatus" TEXT,
  "contentHash" TEXT,
  "respondentEmail" TEXT,
  "companyName" TEXT,
  "dealerNumber" TEXT,
  "reviewReasonCode" TEXT,
  "privacyErasedAt" TIMESTAMP(3),
  "lastVerifiedAt" TIMESTAMP(3),
  "lastAttemptAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "deadLetteredAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorHttpStatus" INTEGER,
  "lastErrorRetryable" BOOLEAN,
  "lastErrorAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "JotformSubmission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "JotformSyncState" (
  "formId" TEXT NOT NULL,
  "watermark" TEXT,
  "reconciliationFrom" TEXT,
  "reconciliationOffset" INTEGER NOT NULL DEFAULT 0,
  "reconciliationHighWatermark" TEXT,
  "reconciliationAfterId" TEXT,
  "lastAttemptAt" TIMESTAMP(3),
  "lastSuccessfulAt" TIMESTAMP(3),
  "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "apiLimitRemaining" INTEGER,
  "apiLimitResetAt" TIMESTAMP(3),
  "apiCircuitOpenUntil" TIMESTAMP(3),
  "apiCircuitReason" TEXT,
  "apiLeaseToken" TEXT,
  "apiLeaseExpiresAt" TIMESTAMP(3),
  "lastOperationalAlertAt" TIMESTAMP(3),
  "lastOperationalAlertHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "JotformSyncState_pkey" PRIMARY KEY ("formId")
);

CREATE UNIQUE INDEX "JotformSubmission_formId_submissionId_key"
  ON "JotformSubmission"("formId", "submissionId");

CREATE INDEX "JotformSubmission_syncStatus_nextAttemptAt_idx"
  ON "JotformSubmission"("syncStatus", "nextAttemptAt");

CREATE INDEX "JotformSubmission_formId_vendorUpdatedAt_submissionId_idx"
  ON "JotformSubmission"("formId", "vendorUpdatedAt", "submissionId");

CREATE INDEX "JotformSubmission_respondentEmail_idx"
  ON "JotformSubmission"("respondentEmail");
