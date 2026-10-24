import { isPrismaUniqueConstraintError } from '../prisma/prisma-error';
import { PushService } from '../push/push.service';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  NotFoundException,
} from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { CURRENT_TERMS_VERSION } from '../legal/legal.constants';
import { PrismaService } from '../prisma/prisma.service';
import { MarkReadDto, SendMessageDto } from './dto/messaging.dto';
import { assertPreviewOperationsConfigured } from '../config/preview-operations';

@Injectable()
export class MessagingService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly push?: PushService,
  ) {}

  async listConversations(userId: string) {
    const participantRows = await this.prisma.conversationParticipant.findMany({
      where: { userId },
      include: {
        conversation: {
          include: {
            participants: {
              include: {
                user: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    role: true,
                  },
                },
              },
            },
            messages: {
              where: { deletedAt: null },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    const [counts, blocks] = await Promise.all([
      this.prisma.$queryRaw<Array<{ conversationId: string; unread: number }>>`
        SELECT p."conversationId", COUNT(m."id")::integer AS unread
        FROM "ConversationParticipant" p
        LEFT JOIN "Message" m ON m."conversationId" = p."conversationId"
          AND m."senderId" <> ${userId} AND m."deletedAt" IS NULL
          AND (p."lastReadAt" IS NULL OR m."createdAt" > p."lastReadAt")
        WHERE p."userId" = ${userId} GROUP BY p."conversationId"`,
      this.prisma.userBlock.findMany({
        where: { OR: [{ blockerId: userId }, { blockedUserId: userId }] },
        select: { blockerId: true, blockedUserId: true },
      }),
    ]);
    const unread = new Map(
      counts.map((row) => [row.conversationId, row.unread]),
    );
    const blocked = new Set(
      blocks
        .filter((row) => row.blockerId === userId)
        .map((row) => row.blockedUserId),
    );
    const blockedBy = new Set(
      blocks
        .filter((row) => row.blockedUserId === userId)
        .map((row) => row.blockerId),
    );
    const conversations = participantRows.map((participant) => ({
      ...participant.conversation,
      currentUserLastReadAt: participant.lastReadAt,
      unreadCount: unread.get(participant.conversationId) ?? 0,
      lastMessage: participant.conversation.messages[0] ?? null,
      currentUserHasBlockedParticipant:
        participant.conversation.participants.some((other) =>
          blocked.has(other.userId),
        ),
      currentUserIsBlocked: participant.conversation.participants.some(
        (other) => blockedBy.has(other.userId),
      ),
    }));

    conversations.sort((a, b) => {
      const aTime = a.lastMessageAt?.getTime() ?? a.createdAt.getTime();
      const bTime = b.lastMessageAt?.getTime() ?? b.createdAt.getTime();
      return bTime - aTime;
    });

    return { conversations };
  }

  async getConversation(userId: string, conversationId: string) {
    await this.ensureParticipant(conversationId, userId);

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        participants: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                role: true,
              },
            },
          },
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const blockState = await this.getBlockState(conversationId, userId);
    return {
      conversation: {
        ...conversation,
        currentUserHasBlockedParticipant: blockState.blockedByCurrentUser,
        currentUserIsBlocked: blockState.blockedByParticipant,
      },
    };
  }

  async getMessages(userId: string, conversationId: string, cursor?: string) {
    await this.ensureParticipant(conversationId, userId);

    const boundary = cursor
      ? await this.prisma.message.findFirst({
          where: { id: cursor, conversationId },
          select: { id: true, createdAt: true },
        })
      : null;
    if (cursor && !boundary)
      throw new BadRequestException('Invalid message history cursor');
    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        ...(boundary
          ? {
              OR: [
                { createdAt: { lt: boundary.createdAt } },
                { createdAt: boundary.createdAt, id: { lt: boundary.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
    const hasMore = messages.length > 50;
    const page = messages.slice(0, 50).reverse();
    return { messages: page, nextCursor: hasMore ? page[0].id : null };
  }

  async sendMessage(userId: string, dto: SendMessageDto) {
    await this.ensureParticipant(dto.conversationId, userId);
    await this.ensureTermsAccepted(userId);
    await this.ensureMessagingAllowed(dto.conversationId, userId);

    const body = dto.body.trim();
    if (!body) {
      throw new BadRequestException('Message body cannot be empty');
    }
    if (body.length > 2_000) {
      throw new BadRequestException(
        'Messages must be 2,000 characters or less',
      );
    }
    this.ensureMessageDoesNotContainBlockedContent(body);

    const existing = await this.prisma.message.findUnique({
      where: {
        senderId_clientMessageId: {
          senderId: userId,
          clientMessageId: dto.clientMessageId,
        },
      },
    });

    if (existing) {
      if (existing.conversationId !== dto.conversationId || existing.deletedAt)
        throw new BadRequestException(
          'This message identifier cannot be reused.',
        );
      return existing;
    }

    await this.ensureMessageRateLimit(userId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const message = await tx.message.create({
          data: {
            conversationId: dto.conversationId,
            senderId: userId,
            clientMessageId: dto.clientMessageId,
            body,
          },
        });

        await tx.conversation.update({
          where: { id: dto.conversationId },
          data: { lastMessageAt: message.createdAt },
        });

        await this.push?.enqueue(tx, message);
        return message;
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error, 'clientMessageId')) {
        const saved = await this.prisma.message.findUnique({
          where: {
            senderId_clientMessageId: {
              senderId: userId,
              clientMessageId: dto.clientMessageId,
            },
          },
        });
        if (
          saved &&
          saved.conversationId === dto.conversationId &&
          !saved.deletedAt
        )
          return saved;
      }
      throw error;
    }
  }

  async markRead(userId: string, dto: MarkReadDto) {
    await this.ensureParticipant(dto.conversationId, userId);
    await this.ensureMessagingAllowed(dto.conversationId, userId);

    let lastReadAt = new Date(Math.min(Date.parse(dto.lastReadAt), Date.now()));
    if (dto.lastMessageId) {
      const message = await this.prisma.message.findFirst({
        where: {
          id: dto.lastMessageId,
          conversationId: dto.conversationId,
          deletedAt: null,
        },
        select: { createdAt: true },
      });
      if (!message) throw new BadRequestException('Read message not found');
      lastReadAt = new Date(Math.min(message.createdAt.getTime(), Date.now()));
    }
    if (!Number.isFinite(lastReadAt.getTime()))
      throw new BadRequestException('Invalid read timestamp');
    await this.prisma.conversationParticipant.updateMany({
      where: {
        conversationId: dto.conversationId,
        userId,
        OR: [{ lastReadAt: null }, { lastReadAt: { lt: lastReadAt } }],
      },
      data: { lastReadAt },
    });
    return this.prisma.conversationParticipant.findUniqueOrThrow({
      where: {
        conversationId_userId: { conversationId: dto.conversationId, userId },
      },
    });
  }

  async ensureParticipant(conversationId: string, userId: string) {
    const participant = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });

    if (!participant) {
      throw new ForbiddenException('User is not a conversation participant');
    }

    return participant;
  }

  async reportMessage(
    userId: string,
    conversationId: string,
    messageId: string,
    reason?: string,
  ) {
    await this.ensureParticipant(conversationId, userId);
    assertPreviewOperationsConfigured();
    const message = await this.prisma.message.findFirst({
      where: {
        id: messageId,
        conversationId,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    const existingReport = await this.prisma.messageReport.findUnique({
      where: {
        messageId_reporterId: {
          messageId: message.id,
          reporterId: userId,
        },
      },
      select: { id: true },
    });

    if (!existingReport) {
      const recentReports = await this.prisma.messageReport.count({
        where: {
          reporterId: userId,
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1_000) },
        },
      });
      if (recentReports >= 10) {
        throw new HttpException(
          'Too many reports were submitted. Please try again later.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const report = await this.prisma.messageReport.upsert({
      where: {
        messageId_reporterId: {
          messageId: message.id,
          reporterId: userId,
        },
      },
      create: {
        messageId: message.id,
        reporterId: userId,
        reason: reason?.trim() || 'Reported from the app',
      },
      update: {
        reason: reason?.trim() || 'Reported from the app',
        status: 'OPEN',
        resolvedAt: null,
        resolution: null,
        resolutionBy: null,
      },
    });

    void this.notifyOperations({
      event: 'message_reported',
      reportId: report.id,
      text: 'Hercules Honors Rewards: a message report needs review.',
    });

    return { message: 'Your report has been sent to Hercules for review.' };
  }

  async blockParticipant(userId: string, conversationId: string) {
    const otherUserId = await this.getOtherParticipantUserId(
      conversationId,
      userId,
    );
    await this.prisma.userBlock.upsert({
      where: {
        blockerId_blockedUserId: {
          blockerId: userId,
          blockedUserId: otherUserId,
        },
      },
      create: { blockerId: userId, blockedUserId: otherUserId },
      update: {},
    });

    return { blocked: true };
  }

  async unblockParticipant(userId: string, conversationId: string) {
    const otherUserId = await this.getOtherParticipantUserId(
      conversationId,
      userId,
    );
    await this.prisma.userBlock.deleteMany({
      where: { blockerId: userId, blockedUserId: otherUserId },
    });

    return { blocked: false };
  }

  async ensureMessagingAllowed(conversationId: string, userId: string) {
    const participants = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { user: { select: { status: true } } },
    });
    if (
      participants.length < 2 ||
      participants.some(
        (participant) => participant.user.status !== UserStatus.ACTIVE,
      )
    ) {
      throw new ForbiddenException(
        'Messaging is unavailable because this conversation is no longer active',
      );
    }

    const blockState = await this.getBlockState(conversationId, userId);
    if (blockState.blockedByCurrentUser || blockState.blockedByParticipant) {
      throw new ForbiddenException(
        'Messaging is unavailable because this conversation has been blocked',
      );
    }
  }

  private async ensureTermsAccepted(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { termsAcceptedAt: true, termsVersion: true },
    });
    if (!user?.termsAcceptedAt || user.termsVersion !== CURRENT_TERMS_VERSION) {
      throw new ForbiddenException(
        'Please review and accept the current Terms of Use before sending messages',
      );
    }
  }

  private async ensureMessageRateLimit(userId: string) {
    const sentInLastMinute = await this.prisma.message.count({
      where: {
        senderId: userId,
        createdAt: { gte: new Date(Date.now() - 60_000) },
      },
    });

    if (sentInLastMinute >= 30) {
      throw new HttpException(
        'You are sending messages too quickly. Please wait a moment and try again.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private async notifyOperations(payload: {
    event: 'message_reported';
    reportId: string;
    text: string;
  }) {
    const webhookUrl = process.env.OPERATIONS_WEBHOOK_URL;
    if (!webhookUrl) {
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`Operations webhook responded with ${response.status}`);
      }
    } catch {
      // A notification outage must not prevent a user from reporting content;
      // the database record remains in the queue for the moderation owner.
      console.error('Unable to notify operations about a message report');
    }
  }

  private async getBlockState(conversationId: string, userId: string) {
    const otherUserId = await this.getOtherParticipantUserId(
      conversationId,
      userId,
    );
    const [blockedByCurrentUser, blockedByParticipant] = await Promise.all([
      this.prisma.userBlock.findUnique({
        where: {
          blockerId_blockedUserId: {
            blockerId: userId,
            blockedUserId: otherUserId,
          },
        },
      }),
      this.prisma.userBlock.findUnique({
        where: {
          blockerId_blockedUserId: {
            blockerId: otherUserId,
            blockedUserId: userId,
          },
        },
      }),
    ]);

    return {
      blockedByCurrentUser: Boolean(blockedByCurrentUser),
      blockedByParticipant: Boolean(blockedByParticipant),
    };
  }

  private async getOtherParticipantUserId(
    conversationId: string,
    userId: string,
  ) {
    await this.ensureParticipant(conversationId, userId);
    const participants = await this.prisma.conversationParticipant.findMany({
      where: { conversationId },
      select: { userId: true },
    });
    const otherUserId = participants.find(
      (participant) => participant.userId !== userId,
    )?.userId;

    if (!otherUserId) {
      throw new BadRequestException(
        'This conversation does not have another participant',
      );
    }

    return otherUserId;
  }

  private ensureMessageDoesNotContainBlockedContent(body: string) {
    const terms = (process.env.MESSAGE_BLOCKED_TERMS ?? '')
      .split(',')
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean);
    const normalizedBody = body.toLowerCase();
    if (terms.some((term) => normalizedBody.includes(term))) {
      throw new BadRequestException(
        'This message includes content that is not permitted in Hercules Honors Rewards',
      );
    }
  }
}
