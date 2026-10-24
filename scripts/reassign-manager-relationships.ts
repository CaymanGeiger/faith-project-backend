import { PrismaClient, UserRole, UserStatus } from '@prisma/client';

const prisma = new PrismaClient();

function readOption(name: string) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index !== -1) {
    return args[index + 1];
  }

  const prefixed = args.find((argument) => argument.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

async function main() {
  const fromManagerId = readOption('--from-manager-id');
  const toManagerId = readOption('--to-manager-id');
  if (!fromManagerId || !toManagerId) {
    throw new Error(
      'Usage: npm run privacy:reassign-manager -- --from-manager-id <id> --to-manager-id <id>',
    );
  }
  if (fromManagerId === toManagerId) {
    throw new Error('Choose a different active sales manager as the reassignment target');
  }

  const [fromManager, toManager] = await Promise.all([
    prisma.user.findUnique({
      where: { id: fromManagerId },
      select: { id: true, role: true },
    }),
    prisma.user.findUnique({
      where: { id: toManagerId },
      select: { id: true, role: true, status: true },
    }),
  ]);
  if (!fromManager || fromManager.role !== UserRole.SALES_MANAGER) {
    throw new Error('The source account is not a sales manager');
  }
  if (
    !toManager ||
    toManager.role !== UserRole.SALES_MANAGER ||
    toManager.status !== UserStatus.ACTIVE
  ) {
    throw new Error('The reassignment target must be an active sales manager');
  }

  const prospects = await prisma.prospectProfile.findMany({
    where: { assignedSalesManagerId: fromManagerId },
    select: { userId: true },
  });

  const result = await prisma.$transaction(async (tx) => {
    const [prospectUpdate, leadUpdate, inviteUpdate] = await Promise.all([
      tx.prospectProfile.updateMany({
        where: { assignedSalesManagerId: fromManagerId },
        data: { assignedSalesManagerId: toManagerId },
      }),
      tx.leadRecord.updateMany({
        where: { assignedSalesManagerId: fromManagerId },
        data: { assignedSalesManagerId: toManagerId },
      }),
      tx.registrationInvite.updateMany({
        where: { assignedSalesManagerId: fromManagerId, usedAt: null },
        data: { assignedSalesManagerId: toManagerId },
      }),
    ]);

    for (const prospect of prospects) {
      const existingConversation = await tx.conversation.findFirst({
        where: {
          AND: [
            { participants: { some: { userId: prospect.userId } } },
            { participants: { some: { userId: toManagerId } } },
          ],
        },
        select: { id: true },
      });
      if (!existingConversation) {
        await tx.conversation.create({
          data: {
            participants: {
              createMany: {
                data: [
                  { userId: prospect.userId },
                  { userId: toManagerId },
                ],
              },
            },
          },
        });
      }
    }

    return {
      prospects: prospectUpdate.count,
      leadRecords: leadUpdate.count,
      unusedInvites: inviteUpdate.count,
    };
  });

  console.log(JSON.stringify(result));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
