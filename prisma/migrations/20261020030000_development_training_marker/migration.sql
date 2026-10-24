-- Only local development tooling may set this marker. Existing and manager-
-- verified evidence remains false and cannot be deleted by the test toggle.
ALTER TABLE "InitialTrainingVerification"
  ADD COLUMN "developmentOnly" BOOLEAN NOT NULL DEFAULT false;
