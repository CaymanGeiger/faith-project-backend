-- Remove the temporary content shipped by the original demo seed. These are
-- exact legacy URLs, so manually created content is not modified.
-- If an administrator already created the current official row, retain that
-- row and remove only the legacy duplicate before changing the old URL.
DELETE FROM "ClassSession" AS legacy
WHERE legacy."virtualUrl" = 'https://example.com/lg-foundations'
  AND EXISTS (
    SELECT 1 FROM "ClassSession" AS current
    WHERE current."virtualUrl" = 'https://lghvac.com/training'
  );

DELETE FROM "ClassSession" AS legacy
WHERE legacy."virtualUrl" = 'https://example.com/lg-registration'
  AND EXISTS (
    SELECT 1 FROM "ClassSession" AS current
    WHERE current."virtualUrl" = 'https://www.herculesindustries.com/eventcalendar'
  );

DELETE FROM "Resource" AS legacy
WHERE legacy."url" = 'https://example.com/lg-catalog-overview'
  AND EXISTS (
    SELECT 1 FROM "Resource" AS current
    WHERE current."url" = 'https://lghvac.com/residential-light-commercial/lg-pro-dealer-program/'
  );

DELETE FROM "Resource" AS legacy
WHERE legacy."url" = 'https://example.com/registration-overview'
  AND EXISTS (
    SELECT 1 FROM "Resource" AS current
    WHERE current."url" = 'https://lghvac.com/warranty-page/'
  );

DELETE FROM "Resource" AS legacy
WHERE legacy."url" = 'https://apps.apple.com/us/search?term=LG%20ThinQ'
  AND EXISTS (
    SELECT 1 FROM "Resource" AS current
    WHERE current."url" = 'https://www.lg.com/us/discover/thinq/app.jsp'
  );

DELETE FROM "Resource" AS legacy
WHERE legacy."url" = 'https://apps.apple.com/us/search?term=LG%20HVAC%20Service'
  AND EXISTS (
    SELECT 1 FROM "Resource" AS current
    WHERE current."url" = 'https://lghvac.com/training'
  );

DELETE FROM "Resource" AS legacy
WHERE legacy."url" = 'https://apps.apple.com/us/search?term=LGMV-Business'
  AND EXISTS (
    SELECT 1 FROM "Resource" AS current
    WHERE current."url" = 'https://lghvac.com/resources/'
  );

DELETE FROM "Benefit" AS legacy
WHERE legacy."url" = 'https://example.com/dealer-discounts'
  AND EXISTS (
    SELECT 1 FROM "Benefit" AS current
    WHERE current."url" = 'https://lghvac.com/residential-light-commercial/lg-pro-dealer-program/'
  );

DELETE FROM "Benefit" AS legacy
WHERE legacy."url" = 'https://example.com/warranty-support'
  AND EXISTS (
    SELECT 1 FROM "Benefit" AS current
    WHERE current."url" = 'https://lghvac.com/warranty-page/'
  );

DELETE FROM "Benefit" AS legacy
WHERE legacy."url" = 'https://example.com/lead-generation'
  AND EXISTS (
    SELECT 1 FROM "Benefit" AS current
    WHERE current."url" = 'https://lghvac.com/resources/'
  );

UPDATE "ClassSession"
SET
  "title" = 'LG Dealer Certification: Foundations',
  "description" = 'Save your training preference here. Hercules will confirm final enrollment and class logistics.',
  "virtualUrl" = 'https://lghvac.com/training'
WHERE "virtualUrl" = 'https://example.com/lg-foundations';

UPDATE "ClassSession"
SET
  "title" = 'LG Equipment Registration Workshop',
  "description" = 'Save your workshop preference here. Hercules will confirm availability and registration details.',
  "virtualUrl" = 'https://www.herculesindustries.com/eventcalendar'
WHERE "virtualUrl" = 'https://example.com/lg-registration';

UPDATE "Resource"
SET
  "title" = 'LG Pro Dealer Program',
  "description" = 'Review current LG Pro Dealer program information, benefits, and eligibility details.',
  "resourceType" = 'CATALOG',
  "category" = 'LG Pro Dealer',
  "url" = 'https://lghvac.com/residential-light-commercial/lg-pro-dealer-program/'
WHERE "url" = 'https://example.com/lg-catalog-overview';

UPDATE "Resource"
SET
  "title" = 'LG Warranty & Registration',
  "description" = 'Review LG registration and warranty requirements for eligible equipment.',
  "resourceType" = 'REGISTRATION_OVERVIEW',
  "category" = 'Registration',
  "url" = 'https://lghvac.com/warranty-page/'
WHERE "url" = 'https://example.com/registration-overview';

UPDATE "Resource"
SET
  "title" = 'LG ThinQ',
  "description" = 'Review LG ThinQ information and download options for supported connected products.',
  "resourceType" = 'APP',
  "category" = 'LG Apps',
  "url" = 'https://www.lg.com/us/discover/thinq/app.jsp'
WHERE "url" = 'https://apps.apple.com/us/search?term=LG%20ThinQ';

UPDATE "Resource"
SET
  "title" = 'LG HVAC Training',
  "description" = 'Explore current LG HVAC training options for contractors and technicians.',
  "resourceType" = 'DOCUMENT',
  "category" = 'Training',
  "url" = 'https://lghvac.com/training'
WHERE "url" = 'https://apps.apple.com/us/search?term=LG%20HVAC%20Service';

UPDATE "Resource"
SET
  "title" = 'LG HVAC Resource Library',
  "description" = 'Browse LG HVAC technical resources, product literature, and service tools.',
  "resourceType" = 'DOCUMENT',
  "category" = 'LG Resources',
  "url" = 'https://lghvac.com/resources/'
WHERE "url" = 'https://apps.apple.com/us/search?term=LGMV-Business';

UPDATE "Benefit"
SET
  "title" = 'LG Pro Dealer Benefits',
  "description" = 'Review current LG Pro Dealer benefits, tiers, and eligibility requirements.',
  "benefitType" = 'DISCOUNT',
  "url" = 'https://lghvac.com/residential-light-commercial/lg-pro-dealer-program/'
WHERE "url" = 'https://example.com/dealer-discounts';

UPDATE "Benefit"
SET
  "title" = 'LG Warranty & Registration Support',
  "description" = 'Review warranty and registration requirements for eligible LG HVAC products.',
  "benefitType" = 'WARRANTY',
  "url" = 'https://lghvac.com/warranty-page/'
WHERE "url" = 'https://example.com/warranty-support';

UPDATE "Benefit"
SET
  "title" = 'LG HVAC Resources & Marketing Support',
  "description" = 'Review current LG HVAC resources, then contact Hercules about available marketing and lead support.',
  "benefitType" = 'LEAD_GENERATION',
  "url" = 'https://lghvac.com/resources/'
WHERE "url" = 'https://example.com/lead-generation';

-- Availability is stored in this app until a real external LeadSmart contract
-- exists. Earlier statuses were not evidence of an external submission.
UPDATE "ProspectProfile"
SET "marketingConsultationCompletedAt" = NULL
WHERE "userId" IN (
  SELECT "prospectUserId"
  FROM "MarketingConsultation"
  WHERE "externalSubmissionStatus" = 'SUBMITTED'
);

UPDATE "MarketingConsultation"
SET
  "externalSubmissionStatus" = 'NOT_SUBMITTED',
  "completedAt" = NULL
WHERE "externalSubmissionStatus" = 'SUBMITTED';

UPDATE "TodoItem"
SET "title" = 'Share Marketing Availability'
WHERE
  "type" = 'MARKETING_CONSULTATION'
  AND "title" = 'Schedule Your Marketing Consultation';

-- These records remain in Hercules Honors Rewards unless and until an approved
-- manufacturer or partner integration is configured. Do not label them as an
-- external registration or confirmed enrollment.
UPDATE "TodoItem"
SET
  "title" = 'Add Your First LG System',
  "description" = 'Save your first equipment record in Hercules Honors Rewards for dealer onboarding.'
WHERE
  "type" = 'EQUIPMENT_REGISTRATION'
  AND "title" = 'Register Your First LG System';

UPDATE "TodoItem"
SET
  "title" = 'Record Your JB Warranties Setup',
  "description" = 'After completing JB Warranties setup, record that completion for your Hercules onboarding.'
WHERE
  "type" = 'JB_WARRANTIES'
  AND "title" = 'Enroll in JB Warranties';

ALTER TABLE "MessageReport"
  ADD COLUMN "resolvedAt" TIMESTAMP(3),
  ADD COLUMN "resolution" TEXT;
