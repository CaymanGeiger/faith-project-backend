import { PrismaClient } from '@prisma/client';
import { preparePreviewFixtures } from '../src/config/preview-fixtures';

const prisma = new PrismaClient();
void preparePreviewFixtures(prisma)
  .then((result) => console.log(JSON.stringify(result)))
  .catch(() => {
    console.error(
      'Preview fixture setup refused or failed. Check the explicit preview flags, migrations and reserved fixture evidence.',
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
