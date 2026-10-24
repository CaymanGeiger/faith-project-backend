import { MessageReportStatus, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function readOption(name: string) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index !== -1) {
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`${name} requires a value`);
    }
    return value;
  }

  const prefixed = args.find((argument) => argument.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

function requireResolutionDetails() {
  const resolution = readOption('--resolution')?.trim();
  const resolvedBy = readOption('--resolved-by')?.trim();
  if (!resolution) {
    throw new Error('Provide --resolution "<review outcome>" when resolving or removing content');
  }
  if (!resolvedBy) {
    throw new Error('Provide --resolved-by "<operator identifier>" when resolving or removing content');
  }
  if (resolution.length > 1_000) {
    throw new Error('Resolution must be 1,000 characters or fewer');
  }
  if (resolvedBy.length > 160) {
    throw new Error('Resolved-by must be 160 characters or fewer');
  }
  return { resolution, resolvedBy };
}

async function listOpenReports() {
  const reports = await prisma.messageReport.findMany({
    where: { status: MessageReportStatus.OPEN },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      reason: true,
      createdAt: true,
      message: {
        select: {
          id: true,
          body: true,
          sender: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
      },
      reporter: { select: { id: true, email: true, firstName: true, lastName: true } },
    },
  });
  console.log(JSON.stringify({ reports }, null, 2));
}

async function main() {
  const reportId = readOption('--resolve');
  const messageId = readOption('--remove-message');

  if (reportId && messageId) {
    throw new Error('Choose either --resolve or --remove-message, not both');
  }
  if (reportId) {
    const { resolution, resolvedBy } = requireResolutionDetails();
    await prisma.messageReport.update({
      where: { id: reportId },
      data: {
        status: MessageReportStatus.RESOLVED,
        resolvedAt: new Date(),
        resolution,
        resolutionBy: resolvedBy,
      },
    });
    console.log(JSON.stringify({ reportId, status: 'RESOLVED' }));
    return;
  }
  if (messageId) {
    const { resolution, resolvedBy } = requireResolutionDetails();
    const result = await prisma.$transaction(async (tx) => {
      const message = await tx.message.update({
        where: { id: messageId },
        data: { deletedAt: new Date() },
        select: { id: true },
      });
      const reports = await tx.messageReport.updateMany({
        where: { messageId, status: MessageReportStatus.OPEN },
        data: {
          status: MessageReportStatus.RESOLVED,
          resolvedAt: new Date(),
          resolution,
          resolutionBy: resolvedBy,
        },
      });
      return { messageId: message.id, resolvedReports: reports.count };
    });
    console.log(JSON.stringify(result));
    return;
  }

  await listOpenReports();
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
