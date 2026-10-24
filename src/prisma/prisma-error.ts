import { Prisma } from '@prisma/client';

/**
 * Keep database-specific constraint details out of HTTP responses while still
 * allowing the request handler to distinguish an expected duplicate from an
 * unexpected database failure.
 */
export function isPrismaUniqueConstraintError(
  error: unknown,
  expectedField: string,
): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  ) {
    return false;
  }

  const target = error.meta?.target;
  return Array.isArray(target) && target.includes(expectedField);
}
