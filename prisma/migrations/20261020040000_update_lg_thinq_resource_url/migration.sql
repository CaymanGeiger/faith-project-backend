-- Retain an already-created current resource and its custom metadata when the
-- unique destination already exists. Resource has no dependent foreign keys.
DELETE FROM "Resource" AS legacy
WHERE legacy."url" = 'https://www.lg.com/us/discover/thinq/app.jsp'
  AND EXISTS (
    SELECT 1 FROM "Resource" AS current
    WHERE current."url" = 'https://www.lg.com/us/lg-thinq'
  );

-- Otherwise preserve the existing ID and all custom content, changing only
-- the retired destination and its modification timestamp.
UPDATE "Resource"
SET "url" = 'https://www.lg.com/us/lg-thinq',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "url" = 'https://www.lg.com/us/discover/thinq/app.jsp';
