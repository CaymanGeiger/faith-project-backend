ALTER TABLE "SalesManagerProfile"
  ADD COLUMN "availabilityTimezone" TEXT,
  ADD COLUMN "availabilityHours" JSONB,
  ADD COLUMN "availabilityMode" TEXT NOT NULL DEFAULT 'SCHEDULE',
  ADD COLUMN "availabilityOverrideUntil" TIMESTAMP(3),
  ADD COLUMN "silenceWhenUnavailable" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "SalesManagerProfile" ADD CONSTRAINT "SalesManagerProfile_availabilityMode_check"
  CHECK ("availabilityMode" IN ('SCHEDULE', 'AVAILABLE', 'AWAY'));
