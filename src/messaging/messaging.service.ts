import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MarkReadDto, SendMessageDto } from './dto/messaging.dto';

@Injectable()
export class MessagingService {
  constructor(private readonly prisma: PrismaService) {}

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

    const conversations = await Promise.all(
      participantRows.map(async (participant) => {
        const unreadCount = await this.prisma.message.count({
          where: {
            conversationId: participant.conversationId,
            senderId: { not: userId },
            deletedAt: null,
            createdAt: participant.lastReadAt
              ? { gt: participant.lastReadAt }
              : undefined,
          },
        });

        return {
          ...participant.conversation,
          currentUserLastReadAt: participant.lastReadAt,
          unreadCount,
          lastMessage: participant.conversation.messages[0] ?? null,
        };
      }),
    );

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

    return { conversation };
  }

  async getMessages(userId: string, conversationId: string, cursor?: string) {
    await this.ensureParticipant(conversationId, userId);

    const messages = await this.prisma.message.findMany({
      where: { conversationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const orderedMessages = messages.reverse();

    return {
      messages: orderedMessages,
      nextCursor: messages.length === 50 ? orderedMessages[0]?.id : null,
    };
  }

  async sendMessage(userId: string, dto: SendMessageDto) {
    await this.ensureParticipant(dto.conversationId, userId);

    const body = dto.body.trim();
    if (!body) {
      throw new BadRequestException('Message body cannot be empty');
    }

    const existing = await this.prisma.message.findUnique({
      where: {
        senderId_clientMessageId: {
          senderId: userId,
          clientMessageId: dto.clientMessageId,
        },
      },
    });

    if (existing) {
      return existing;
    }

    return this.prisma.$transaction(async (tx) => {
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

      return message;
    });
  }

  async markRead(userId: string, dto: MarkReadDto) {
    await this.ensureParticipant(dto.conversationId, userId);

    const participant = await this.prisma.conversationParticipant.update({
      where: {
        conversationId_userId: {
          conversationId: dto.conversationId,
          userId,
        },
      },
      data: { lastReadAt: new Date(dto.lastReadAt) },
    });

    return participant;
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
}
