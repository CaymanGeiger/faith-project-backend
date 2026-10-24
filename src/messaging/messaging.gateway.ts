import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConversationEventDto,
  MarkReadDto,
  SendMessageDto,
} from './dto/messaging.dto';
import { MessagingService } from './messaging.service';
import { isProductionLikeRuntime } from '../config/runtime';
import { isAccountAllowedInRuntime } from '../config/development';

const socketCorsOrigins = (process.env.CORS_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

type MessagingSocket = Omit<Socket, 'data'> & {
  data: {
    user?: AuthenticatedUser;
  };
};

type DtoConstructor<T> = new () => T;

@WebSocketGateway({
  namespace: '/messaging',
  cors: {
    origin:
      socketCorsOrigins.length > 0
        ? socketCorsOrigins
        : isProductionLikeRuntime()
          ? false
          : true,
    credentials: true,
  },
})
export class MessagingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly sessionTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  handleDisconnect(client: MessagingSocket) {
    clearTimeout(this.sessionTimers.get(client.id));
    this.sessionTimers.delete(client.id);
  }
  @WebSocketServer()
  server!: Server;

  private readonly eventRateWindows = new Map<
    string,
    { count: number; startedAt: number }
  >();

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly messagingService: MessagingService,
  ) {}

  async handleConnection(client: MessagingSocket) {
    try {
      const user = await this.authenticateClient(client);
      await client.join(`user:${user.id}`);
    } catch {
      client.emit('messaging:error', {
        code: 'UNAUTHORIZED',
        message: 'Messaging socket authentication failed',
      });
      client.disconnect(true);
    }
  }

  @SubscribeMessage('conversation:join')
  async joinConversation(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: ConversationEventDto,
  ) {
    try {
      const payload = await this.validatePayload(ConversationEventDto, dto);
      const user = await this.authenticateClient(client);
      this.ensureSocketEventRateLimit(user.id, 'join', 30);
      await this.messagingService.ensureParticipant(
        payload.conversationId,
        user.id,
      );
      await client.join(this.roomName(payload.conversationId));
      client.emit('conversation:joined', {
        conversationId: payload.conversationId,
      });
      return { ok: true };
    } catch (caught) {
      return this.emitRequestError(client, caught);
    }
  }

  @SubscribeMessage('conversation:leave')
  async leaveConversation(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: ConversationEventDto,
  ) {
    try {
      const payload = await this.validatePayload(ConversationEventDto, dto);
      const user = await this.authenticateClient(client);
      this.ensureSocketEventRateLimit(user.id, 'leave', 30);
      await this.messagingService.ensureParticipant(
        payload.conversationId,
        user.id,
      );
      await client.leave(this.roomName(payload.conversationId));
      return { ok: true };
    } catch (caught) {
      return this.emitRequestError(client, caught);
    }
  }

  @SubscribeMessage('message:send')
  async sendMessage(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: SendMessageDto,
  ) {
    try {
      const payload = await this.validatePayload(SendMessageDto, dto);
      const user = await this.authenticateClient(client);
      this.ensureSocketEventRateLimit(user.id, 'send', 40);
      const message = await this.messagingService.sendMessage(user.id, payload);
      const serializedMessage = {
        id: message.id,
        conversationId: message.conversationId,
        senderId: message.senderId,
        body: message.body,
        clientMessageId: message.clientMessageId,
        createdAt: message.createdAt.toISOString(),
      };
      this.server
        .to(this.roomName(payload.conversationId))
        .emit('message:created', serializedMessage);

      const recipients = await this.prisma.conversationParticipant.findMany({
        where: { conversationId: payload.conversationId },
        select: { userId: true },
      });
      this.server
        .to(recipients.map((recipient) => `user:${recipient.userId}`))
        .emit('conversation:updated', {
          conversationId: payload.conversationId,
        });
      return { ok: true, message: serializedMessage };
    } catch (caught) {
      return this.emitRequestError(client, caught);
    }
  }

  @SubscribeMessage('message:read')
  async markRead(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: MarkReadDto,
  ) {
    try {
      const payload = await this.validatePayload(MarkReadDto, dto);
      const user = await this.authenticateClient(client);
      this.ensureSocketEventRateLimit(user.id, 'read', 60);
      const participant = await this.messagingService.markRead(
        user.id,
        payload,
      );
      client.to(this.roomName(payload.conversationId)).emit('message:read', {
        conversationId: payload.conversationId,
        userId: user.id,
        lastReadAt: participant.lastReadAt?.toISOString() ?? payload.lastReadAt,
      });

      this.server.to(`user:${user.id}`).emit('conversation:updated', {
        conversationId: payload.conversationId,
      });
      return { ok: true };
    } catch (caught) {
      return this.emitRequestError(client, caught);
    }
  }

  @SubscribeMessage('typing:start')
  async typingStart(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: ConversationEventDto,
  ) {
    try {
      const payload = await this.validatePayload(ConversationEventDto, dto);
      const user = await this.authenticateClient(client);
      this.ensureSocketEventRateLimit(user.id, 'typing', 60);
      await this.messagingService.ensureParticipant(
        payload.conversationId,
        user.id,
      );
      await this.messagingService.ensureMessagingAllowed(
        payload.conversationId,
        user.id,
      );
      client.to(this.roomName(payload.conversationId)).emit('typing:started', {
        conversationId: payload.conversationId,
        userId: user.id,
      });
      return { ok: true };
    } catch (caught) {
      return this.emitRequestError(client, caught);
    }
  }

  @SubscribeMessage('typing:stop')
  async typingStop(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: ConversationEventDto,
  ) {
    try {
      const payload = await this.validatePayload(ConversationEventDto, dto);
      const user = await this.authenticateClient(client);
      this.ensureSocketEventRateLimit(user.id, 'typing', 60);
      await this.messagingService.ensureParticipant(
        payload.conversationId,
        user.id,
      );
      await this.messagingService.ensureMessagingAllowed(
        payload.conversationId,
        user.id,
      );
      client.to(this.roomName(payload.conversationId)).emit('typing:stopped', {
        conversationId: payload.conversationId,
        userId: user.id,
      });
      return { ok: true };
    } catch (caught) {
      return this.emitRequestError(client, caught);
    }
  }

  private async authenticateClient(client: MessagingSocket) {
    try {
      const token = this.getToken(client);
      if (!token) {
        throw new Error('Missing auth token');
      }

      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        sv?: number;
        exp?: number;
      }>(token);
      const tokenHash = createHash('sha256').update(token).digest('hex');
      if (await this.prisma.revokedSession.findUnique({ where: { tokenHash } }))
        throw new Error('Revoked session');
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          sessionVersion: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          status: true,
          termsAcceptedAt: true,
          termsVersion: true,
        },
      });

      if (
        !user ||
        user.status !== UserStatus.ACTIVE ||
        !isAccountAllowedInRuntime(user.email)
      ) {
        throw new Error('Inactive or missing user');
      }

      if (
        client.connected === false ||
        (payload.sv ?? 0) !== (user.sessionVersion ?? 0)
      )
        throw new Error('Revoked session');
      // Revalidate passive room subscribers as well as incoming actions.
      clearTimeout(this.sessionTimers.get(client.id));
      const remaining = payload.exp ? payload.exp * 1000 - Date.now() : 60_000;
      if (remaining <= 0) throw new Error('Expired session');
      const timer = setTimeout(
        () => {
          void this.authenticateClient(client).catch(() => undefined);
        },
        Math.min(remaining, 30_000),
      );
      timer.unref?.();
      this.sessionTimers.set(client.id, timer);
      client.data.user = user;
      return user;
    } catch {
      client.emit('messaging:error', {
        code: 'UNAUTHORIZED',
        message: 'Messaging socket is not authenticated',
      });
      this.handleDisconnect(client);
      client.disconnect(true);
      throw new Error('Unauthenticated socket');
    }
  }

  private getToken(client: MessagingSocket) {
    const authToken: unknown = (
      client.handshake.auth as Record<string, unknown>
    ).token;
    if (typeof authToken === 'string') {
      return authToken;
    }

    const header = client.handshake.headers.authorization;
    const [type, token] = header?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }

  private emitRequestError(client: MessagingSocket, caught: unknown) {
    const message =
      caught instanceof HttpException
        ? caught.message
        : 'Unable to complete the messaging request';
    client.emit('messaging:error', {
      code: 'REQUEST_FAILED',
      message,
    });
    return { ok: false, message };
  }

  private async validatePayload<T extends object>(
    Dto: DtoConstructor<T>,
    value: unknown,
  ) {
    const payload = plainToInstance(Dto, value);
    const errors = await validate(payload, {
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
    });
    if (errors.length > 0) {
      throw new HttpException('Invalid messaging request', 400);
    }
    return payload;
  }

  private ensureSocketEventRateLimit(
    userId: string,
    event: string,
    limit: number,
  ) {
    if (this.eventRateWindows.size > 1_000)
      for (const [key, window] of this.eventRateWindows) {
        if (Date.now() - window.startedAt >= 60_000)
          this.eventRateWindows.delete(key);
      }
    const key = `${userId}:${event}`;
    const now = Date.now();
    const existing = this.eventRateWindows.get(key);
    if (!existing || now - existing.startedAt >= 60_000) {
      this.eventRateWindows.set(key, { count: 1, startedAt: now });
      return;
    }
    if (existing.count >= limit) {
      throw new HttpException(
        'Too many messaging requests. Please wait a moment.',
        429,
      );
    }
    existing.count += 1;
  }

  private roomName(conversationId: string) {
    return `conversation:${conversationId}`;
  }
}
