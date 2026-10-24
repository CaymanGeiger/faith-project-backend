import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const OLD_URL = 'https://www.lg.com/us/discover/thinq/app.jsp';
const CURRENT_URL = 'https://www.lg.com/us/lg-thinq';
const migration = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261020040000_update_lg_thinq_resource_url/migration.sql',
  ),
  'utf8',
)
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);

describe('LG ThinQ destination migration', () => {
  const prisma = new PrismaClient();
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each([
    'legacy only',
    'current only',
    'both destinations',
    'unrelated only',
  ])(
    'preserves resource identities and custom content with %s, and is repeatable',
    async (scenario) => {
      await prisma.$transaction(async (tx) => {
        // PostgreSQL resolves this temporary relation first. Every fixture and
        // the unmodified migration SQL operate on it, never actual resources.
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE "Resource" (LIKE public."Resource" INCLUDING ALL) ON COMMIT DROP',
        );
        const insert = async (id: string, url: string) => {
          await tx.$executeRaw`INSERT INTO "Resource" ("id", "title", "description", "resourceType", "url", "category", "createdAt", "updatedAt") VALUES (${id}, ${`${id} custom title`}, ${`${id} custom description`}, 'APP', ${url}, 'Custom category', '2026-01-01', '2026-01-02')`;
        };
        await insert('unrelated', 'https://www.lg.com/us/other-resource');
        if (scenario === 'legacy only' || scenario === 'both destinations')
          await insert('legacy', OLD_URL);
        if (scenario === 'current only' || scenario === 'both destinations')
          await insert('current', CURRENT_URL);
        type Resource = {
          id: string;
          title: string;
          description: string;
          resourceType: string;
          url: string;
          category: string;
          createdAt: Date;
          updatedAt: Date;
        };
        const before = await tx.$queryRaw<
          Resource[]
        >`SELECT * FROM "Resource" ORDER BY "id"`;
        for (const statement of migration)
          await tx.$executeRawUnsafe(statement);
        const after = await tx.$queryRaw<
          Resource[]
        >`SELECT * FROM "Resource" ORDER BY "id"`;
        expect(after.find((row) => row.id === 'unrelated')).toEqual(
          before.find((row) => row.id === 'unrelated'),
        );
        expect(after.some((row) => row.url === OLD_URL)).toBe(false);
        const expectedId =
          scenario === 'legacy only'
            ? 'legacy'
            : scenario === 'unrelated only'
              ? null
              : 'current';
        const canonical = after.find((row) => row.url === CURRENT_URL);
        if (expectedId) {
          const original = before.find((row) => row.id === expectedId)!;
          expect(canonical).toMatchObject({
            ...original,
            url: CURRENT_URL,
            updatedAt: expect.any(Date) as unknown,
          });
          if (expectedId === 'current') expect(canonical).toEqual(original);
          expect(after).toHaveLength(2);
        } else {
          expect(canonical).toBeUndefined();
          expect(after).toHaveLength(1);
        }
        for (const statement of migration)
          await tx.$executeRawUnsafe(statement);
        expect(
          await tx.$queryRaw<
            Resource[]
          >`SELECT * FROM "Resource" ORDER BY "id"`,
        ).toEqual(after);
      });
    },
  );
});
