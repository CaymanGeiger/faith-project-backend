-- Restrict invitation use to the intended recipient in production. Existing
-- invitations remain usable only in local/test environments until the business
-- assigns a recipient email.
ALTER TABLE "RegistrationInvite"
  ADD COLUMN "recipientEmail" TEXT;

CREATE INDEX "RegistrationInvite_recipientEmail_idx"
  ON "RegistrationInvite"("recipientEmail");

-- Preserve who verified a public deletion request before a destructive CLI
-- action is allowed.
ALTER TABLE "AccountDeletionRequest"
  ADD COLUMN "verifiedAt" TIMESTAMP(3),
  ADD COLUMN "verifiedBy" TEXT;

ALTER TABLE "MessageReport"
  ADD COLUMN "resolutionBy" TEXT;

-- Support the manager messaging and moderation queries as the dealer base grows.
CREATE INDEX "ConversationParticipant_userId_idx"
  ON "ConversationParticipant"("userId");

CREATE INDEX "Message_senderId_createdAt_idx"
  ON "Message"("senderId", "createdAt");
