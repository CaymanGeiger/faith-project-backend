-- Existing rows retain their explicit migration value pending approved roster
-- review; every future dealer creation path must start restricted by default.
ALTER TABLE "User" ALTER COLUMN "onboardingRequired" SET DEFAULT true;
