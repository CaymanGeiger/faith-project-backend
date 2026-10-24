import {
  AccountDeletionRequestStatus,
  Prisma,
  PrismaClient,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { eraseOwnedSubmissions } from '../src/jotform/submission-ownership';
import { acquireJotformPrivacyLock } from '../src/jotform/jotform-privacy';

const prisma = new PrismaClient();

async function scrubJotformSubmissions(
  tx: Prisma.TransactionClient,
  email: string,
) {
  await acquireJotformPrivacyLock(tx, email);
  const unresolved = await tx.jotformSubmission.count({ where: { respondentEmail: email, privacyErasedAt: null } });
  if (unresolved) throw new Error('Imported records require verified stable ownership. Bind each owned record before completing deletion; email alone is not proof of ownership.');
}

function readOption(name: string) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  if (index !== -1) {
    return args[index + 1];
  }

  const prefixed = args.find((argument) => argument.startsWith(`${name}=`));
  return prefixed?.slice(name.length + 1);
}

async function deleteUserAndCompleteRequest(
  request: {
    id: string;
    email: string;
    source: import('@prisma/client').AccountDeletionRequestSource;
    verifiedAt: Date | null;
    verifiedBy: string | null;
  },
  account: { id: string; email: string; role: UserRole },
) {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${account.id} FOR UPDATE`;
    const currentAccount = await tx.user.findUnique({
      where: { id: account.id },
      select: { id: true, email: true, role: true },
    });
    if (!currentAccount) {
      await scrubJotformSubmissions(tx, request.email);
      await tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          status: AccountDeletionRequestStatus.COMPLETED,
          completedAt: new Date(),
        },
      });
      return;
    }
    const history = await tx.accountEmailHistory.findMany({ where: { userId: currentAccount.id }, select: { email: true } });
    const emails = [...new Set([request.email, currentAccount.email, ...history.map(row => row.email)])].sort();
    if (!await eraseOwnedSubmissions(tx, currentAccount.id, emails)) throw new Error('Unlinked imported records need ownership verification before completing deletion. Use privacy:link-submission after verifying the records.');
    for (const email of emails) if (email !== request.email && email !== currentAccount.email) await tx.accountDeletionRequest.create({ data: { email, role: currentAccount.role, source: request.source, status: AccountDeletionRequestStatus.COMPLETED, completedAt: new Date(), verifiedAt: request.verifiedAt, verifiedBy: request.verifiedBy } });
    const currentEmail = currentAccount.email.trim().toLowerCase();
    const requestedEmail = request.email.trim().toLowerCase();
    if (currentEmail !== requestedEmail) {
      const existingSuppression = await tx.accountDeletionRequest.findFirst({
        where: {
          email: currentEmail,
          status: AccountDeletionRequestStatus.COMPLETED,
        },
        select: { id: true },
      });
      if (!existingSuppression) {
        const completedAt = new Date();
        await tx.accountDeletionRequest.create({
          data: {
            userId: null,
            email: currentEmail,
            role: currentAccount.role,
            source: request.source,
            status: AccountDeletionRequestStatus.COMPLETED,
            verifiedAt: request.verifiedAt ?? completedAt,
            verifiedBy: request.verifiedBy,
            completedAt,
          },
        });
      }
    }
    await tx.conversation.deleteMany({
      where: { participants: { some: { userId: currentAccount.id } } },
    });
    await tx.user.delete({ where: { id: currentAccount.id } });
    await tx.accountDeletionRequest.update({
      where: { id: request.id },
      data: {
        status: AccountDeletionRequestStatus.COMPLETED,
        completedAt: new Date(),
      },
    });
  });
}

async function main() {
  const requestId = readOption('--request-id');
  if (!requestId) {
    throw new Error(
      'Usage: npm run privacy:process-deletion -- --request-id <request-id>',
    );
  }

  let request = await prisma.accountDeletionRequest.findUnique({
    where: { id: requestId },
  });
  if (!request) {
    throw new Error(`Account deletion request ${requestId} was not found`);
  }
  if (request.status === AccountDeletionRequestStatus.COMPLETED) {
    console.log(JSON.stringify({ requestId, status: 'COMPLETED' }));
    return;
  }
  if (request.status === AccountDeletionRequestStatus.PENDING_VERIFICATION) {
    const verifiedBy = readOption('--verified-by')?.trim();
    if (!request.verifiedAt && !verifiedBy) {
      throw new Error(
        'Verify the requester using the approved support process, then rerun with --verified-by <operator identifier>.',
      );
    }
    if (verifiedBy && verifiedBy.length > 160) {
      throw new Error('--verified-by must be 160 characters or fewer');
    }
    if (!request.verifiedAt) {
      request = await prisma.accountDeletionRequest.update({
        where: { id: request.id },
        data: { verifiedAt: new Date(), verifiedBy },
      });
    }
  }

  if (!request.userId) {
    await prisma.$transaction(async (tx) => {
      await scrubJotformSubmissions(tx, request.email);
      await tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          status: AccountDeletionRequestStatus.COMPLETED,
          completedAt: new Date(),
        },
      });
    });
    console.log(JSON.stringify({ requestId, status: 'COMPLETED' }));
    return;
  }
  const userId = request.userId;

  const account = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true },
  });
  if (!account) {
    await prisma.$transaction(async (tx) => {
      await scrubJotformSubmissions(tx, request.email);
      await tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: {
          status: AccountDeletionRequestStatus.COMPLETED,
          completedAt: new Date(),
        },
      });
    });
    console.log(JSON.stringify({ requestId, status: 'COMPLETED' }));
    return;
  }

  if (
    request.status === AccountDeletionRequestStatus.PENDING_VERIFICATION &&
    account.role === UserRole.PROSPECT
  ) {
    await deleteUserAndCompleteRequest(request, account);
    console.log(JSON.stringify({ requestId, status: 'COMPLETED' }));
    return;
  }

  if (request.status === AccountDeletionRequestStatus.PENDING_VERIFICATION) {
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: account.id },
        data: { status: UserStatus.DISABLED },
      });
      await tx.accountDeletionRequest.update({
        where: { id: request.id },
        data: { status: AccountDeletionRequestStatus.PENDING_REASSIGNMENT },
      });
    });
  }

  if (account.role !== UserRole.SALES_MANAGER) {
    throw new Error(
      'Only prospect and sales-manager account deletion requests are supported',
    );
  }

  const [assignedProspects, assignedLeads, unusedInvites] = await Promise.all([
    prisma.prospectProfile.count({
      where: { assignedSalesManagerId: account.id },
    }),
    prisma.leadRecord.count({
      where: { assignedSalesManagerId: account.id },
    }),
    prisma.registrationInvite.count({
      where: { assignedSalesManagerId: account.id, usedAt: null },
    }),
  ]);

  if (assignedProspects || assignedLeads || unusedInvites) {
    throw new Error(
      `Reassign active relationships before deletion: ${assignedProspects} prospect(s), ${assignedLeads} lead record(s), and ${unusedInvites} unused invite(s) remain. Run privacy:reassign-manager first.`,
    );
  }

  await deleteUserAndCompleteRequest(request, account);
  console.log(JSON.stringify({ requestId, status: 'COMPLETED' }));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
