import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { evaluateAvailability } from '../availability/availability-policy';
import { readAvailabilitySettings } from '../availability/availability.service';

type ExpoResult = {
  status: 'ok' | 'error';
  id?: string;
  details?: { error?: string };
};

@Injectable()
export class PushService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(PushService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(private readonly prisma: PrismaService) {}
  enabled() {
    return process.env.PUSH_NOTIFICATIONS_ENABLED === 'true';
  }

  onApplicationBootstrap() {
    if (!this.enabled()) return;
    this.timer = setInterval(() => {
      void this.process().catch(() => this.logger.error('PUSH_WORKER_FAILED'));
    }, 15_000);
    this.timer.unref();
  }
  onApplicationShutdown() {
    clearInterval(this.timer);
  }

  async register(user: AuthenticatedUser, token: string, platform: string) {
    if (!this.enabled())
      throw new ServiceUnavailableException(
        'Push notifications are not available yet.',
      );
    if (!user.sessionExpiresAt)
      throw new ServiceUnavailableException(
        'Please sign in again to enable notifications.',
      );
    // An Expo token identifies one installation. Account switches transfer ownership.
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.pushDevice.findUnique({ where: { token } });
      if (existing && existing.userId !== user.id)
        await tx.pushDevice.delete({ where: { id: existing.id } });
      await tx.pushDevice.upsert({
        where: { token },
        create: {
          token,
          platform,
          userId: user.id,
          sessionVersion: user.sessionVersion ?? 0,
          sessionTokenHash: user.sessionTokenHash,
          sessionExpiresAt: new Date(user.sessionExpiresAt! * 1000),
        },
        update: {
          userId: user.id,
          platform,
          sessionVersion: user.sessionVersion ?? 0,
          sessionTokenHash: user.sessionTokenHash,
          sessionExpiresAt: new Date(user.sessionExpiresAt! * 1000),
        },
      });
      return { enabled: true };
    });
  }

  async unregister(userId: string, token: string) {
    await this.prisma.pushDevice.deleteMany({ where: { userId, token } });
    return { enabled: false };
  }

  async enqueue(
    tx: Prisma.TransactionClient,
    message: { id: string; conversationId: string; senderId: string },
  ) {
    if (!this.enabled()) return;
    const devices = await tx.pushDevice.findMany({
      where: {
        userId: { not: message.senderId },
        sessionExpiresAt: { gt: new Date() },
        user: {
          status: 'ACTIVE',
          participants: { some: { conversationId: message.conversationId } },
        },
      },
      select: {
        id: true,
        userId: true,
        user: { select: { salesManagerProfile: true } },
      },
    });
    if (devices.length)
      await tx.pushDelivery.createMany({
        data: devices.map((device) => ({
          deviceId: device.id,
          recipientId: device.userId,
          messageId: message.id,
          status: evaluateAvailability(
            readAvailabilitySettings(device.user.salesManagerProfile),
          ).notificationsSilenced
            ? 'SUPPRESSED'
            : 'PENDING',
        })),
        skipDuplicates: true,
      });
  }

  private async expo(
    path: 'send' | 'getReceipts',
    body: unknown,
  ): Promise<unknown> {
    const response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.EXPO_ACCESS_TOKEN
          ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
          : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('PUSH_PROVIDER_UNAVAILABLE');
    return response.json();
  }

  async process() {
    if (!this.enabled() || this.running) return;
    this.running = true;
    try {
      const jobs = await this.prisma.pushDelivery.findMany({
        where: {
          status: { in: ['PENDING', 'RECEIPT'] },
          nextAttemptAt: { lte: new Date() },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
        take: 25,
      });
      for (const job of jobs) {
        const leaseUntil = new Date(Date.now() + 60_000);
        const claimed = await this.prisma.pushDelivery.updateMany({
          where: {
            id: job.id,
            status: job.status,
            receiptId: job.receiptId,
            attempts: job.attempts,
            nextAttemptAt: { lte: new Date() },
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
          },
          data: { leaseUntil },
        });
        if (!claimed.count) continue;
        try {
          const device = await this.prisma.pushDevice.findUnique({
            where: { id: job.deviceId },
            include: { user: { include: { salesManagerProfile: true } } },
          });
          const message = await this.prisma.message.findUnique({
            where: { id: job.messageId },
            include: { sender: { select: { status: true } } },
          });
          const member = message
            ? await this.prisma.conversationParticipant.findUnique({
                where: {
                  conversationId_userId: {
                    conversationId: message.conversationId,
                    userId: job.recipientId,
                  },
                },
              })
            : null;
          const blocked = message
            ? await this.prisma.userBlock.count({
                where: {
                  OR: [
                    {
                      blockerId: job.recipientId,
                      blockedUserId: message.senderId,
                    },
                    {
                      blockerId: message.senderId,
                      blockedUserId: job.recipientId,
                    },
                  ],
                },
              })
            : 0;
          const allowed =
            device &&
            device.userId === job.recipientId &&
            device.user.status === 'ACTIVE' &&
            device.sessionVersion === device.user.sessionVersion &&
            device.sessionExpiresAt > new Date() &&
            message &&
            message.sender.status === 'ACTIVE' &&
            !message.deletedAt &&
            member &&
            !blocked;
          if (
            !allowed ||
            (job.status === 'PENDING' &&
              member?.lastReadAt &&
              message &&
              member.lastReadAt >= message.createdAt)
          ) {
            await this.prisma.pushDelivery.deleteMany({
              where: { id: job.id },
            });
            continue;
          }
          // Recheck at delivery time: switching away must also silence queued retries.
          // A suppressed alert is terminal; messages remain readable without a later alert burst.
          if (
            !job.receiptId &&
            evaluateAvailability(
              readAvailabilitySettings(device.user.salesManagerProfile),
            ).notificationsSilenced
          ) {
            await this.prisma.pushDelivery.updateMany({
              where: { id: job.id, leaseUntil },
              data: { status: 'SUPPRESSED', leaseUntil: null },
            });
            continue;
          }
          let result: ExpoResult | undefined;
          if (job.receiptId) {
            const response = (await this.expo('getReceipts', {
              ids: [job.receiptId],
            })) as { data?: Record<string, ExpoResult> };
            result = response.data?.[job.receiptId];
          } else {
            const response = (await this.expo('send', [
              {
                to: device.token,
                title: 'Hercules Honors Rewards',
                body: 'You have a new chat message. Open the app to read it.',
                data: { type: 'chat', recipientId: job.recipientId },
                sound: 'default',
                channelId: 'messages',
                ttl: 3600,
              },
            ])) as { data?: ExpoResult[] };
            result = response.data?.[0];
          }
          if (result?.status === 'ok' && (job.receiptId || result.id)) {
            await this.prisma.pushDelivery.updateMany({
              where: { id: job.id, leaseUntil },
              data: job.receiptId
                ? { status: 'DONE', leaseUntil: null }
                : {
                    status: 'RECEIPT',
                    receiptId: result.id,
                    attempts: 0,
                    nextAttemptAt: new Date(Date.now() + 15 * 60_000),
                    leaseUntil: null,
                  },
            });
          } else if (result?.details?.error === 'DeviceNotRegistered') {
            await this.prisma.pushDevice.deleteMany({
              where: { id: job.deviceId, token: device.token },
            });
          } else {
            throw new Error('PUSH_RETRY');
          }
        } catch {
          const attempts = job.attempts + 1;
          const failed =
            attempts >= 8 ||
            job.createdAt.getTime() < Date.now() - 24 * 60 * 60_000;
          await this.prisma.pushDelivery.updateMany({
            where: { id: job.id, leaseUntil },
            data: {
              attempts,
              status: failed ? 'FAILED' : job.status,
              leaseUntil: null,
              nextAttemptAt: new Date(
                Date.now() + Math.min(60_000 * 2 ** attempts, 60 * 60_000),
              ),
            },
          });
          if (failed) this.logger.error('PUSH_DELIVERY_FAILED');
        }
      }
      await this.prisma.pushDelivery.deleteMany({
        where: {
          status: { in: ['DONE', 'FAILED', 'SUPPRESSED'] },
          createdAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60_000) },
        },
      });
      await this.prisma.pushDevice.deleteMany({
        where: { sessionExpiresAt: { lt: new Date() } },
      });
    } finally {
      this.running = false;
    }
  }
}
