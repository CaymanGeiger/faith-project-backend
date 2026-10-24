import { randomBytes } from 'node:crypto';
import { InviteStatusRole, PrismaClient, UserRole, UserStatus } from '@prisma/client';
import { hashInviteToken } from '../src/auth/invite-token';

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

function requiredOption(name: string) {
  const value = readOption(name)?.trim();
  if (!value) {
    throw new Error(`Usage: npm run invitations:create -- --email <recipient> --role <PROSPECT|SALES_MANAGER> --manager-id <active-manager-id> --expires-at <ISO-8601>`);
  }
  return value;
}

async function main() {
  const email = requiredOption('--email').toLowerCase();
  const role = requiredOption('--role');
  const bootstrap = process.argv.includes('--bootstrap');
  const managerId = bootstrap ? 'bootstrap' : requiredOption('--manager-id');
  if (bootstrap && role !== InviteStatusRole.SALES_MANAGER) throw new Error('--bootstrap is only for the first sales manager');
  const expiresAtRaw = requiredOption('--expires-at');
  const expiresAt = new Date(expiresAtRaw);

  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) {
    throw new Error('Provide a valid recipient email address');
  }
  if (role !== InviteStatusRole.PROSPECT && role !== InviteStatusRole.SALES_MANAGER) {
    throw new Error('--role must be PROSPECT or SALES_MANAGER');
  }
  if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date()) {
    throw new Error('--expires-at must be a future ISO-8601 timestamp');
  }

  const [existingUser, manager] = await Promise.all([
    prisma.user.findUnique({ where: { email }, select: { id: true } }),
    prisma.user.findFirst({
      where: {
        id: managerId,
        role: UserRole.SALES_MANAGER,
        status: UserStatus.ACTIVE,
      },
      select: { id: true },
    }),
  ]);
  if (existingUser) {
    throw new Error('The recipient already has an account');
  }
  if (!bootstrap && !manager) {
    throw new Error('--manager-id must belong to an active sales manager');
  }

  const rawToken = randomBytes(32).toString('base64url');
  const invite = await prisma.$transaction(async tx => {
    if (bootstrap) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(784618925)::text`;
      const managers = await tx.user.count({ where: { role: UserRole.SALES_MANAGER } });
      const invites = await tx.registrationInvite.count({ where: { roleToCreate: InviteStatusRole.SALES_MANAGER, usedAt: null, expiresAt: { gt: new Date() } } });
      if (managers || invites) throw new Error('Bootstrap requires no existing managers or active manager invitations');
    }
    return tx.registrationInvite.create({
    data: {
      token: hashInviteToken(rawToken),
      recipientEmail: email,
      roleToCreate: role,
      assignedSalesManagerId: manager?.id ?? managerId,
      expiresAt,
    },
    select: { id: true, recipientEmail: true, roleToCreate: true, expiresAt: true },
  });
  });

  // The raw token is intentionally shown once. Send it only through the
  // approved recipient channel; the database stores only its SHA-256 digest.
  console.log(JSON.stringify({ ...invite, invitationToken: rawToken }, null, 2));
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
