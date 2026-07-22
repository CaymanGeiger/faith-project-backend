import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
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

type MessagingSocket = Socket & {
  data: {
    user?: AuthenticatedUser;
  };
};

@WebSocketGateway({
  namespace: '/messaging',
  cors: { origin: '*' },
})
export class MessagingGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly messagingService: MessagingService,
  ) {}

  async handleConnection(client: MessagingSocket) {
    try {
      await this.authenticateClient(client);
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
    const user = await this.authenticateClient(client);
    await this.messagingService.ensureParticipant(dto.conversationId, user.id);
    await client.join(this.roomName(dto.conversationId));
    client.emit('conversation:joined', { conversationId: dto.conversationId });
    return { ok: true };
  }

  @SubscribeMessage('conversation:leave')
  async leaveConversation(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: ConversationEventDto,
  ) {
    await client.leave(this.roomName(dto.conversationId));
    return { ok: true };
  }

  @SubscribeMessage('message:send')
  async sendMessage(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: SendMessageDto,
  ) {
    const user = await this.authenticateClient(client);
    const message = await this.messagingService.sendMessage(user.id, dto);
    this.server.to(this.roomName(dto.conversationId)).emit('message:created', {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      body: message.body,
      clientMessageId: message.clientMessageId,
      createdAt: message.createdAt.toISOString(),
    });

    return { ok: true, messageId: message.id };
  }

  @SubscribeMessage('message:read')
  async markRead(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: MarkReadDto,
  ) {
    const user = await this.authenticateClient(client);
    const participant = await this.messagingService.markRead(user.id, dto);
    client.to(this.roomName(dto.conversationId)).emit('message:read', {
      conversationId: dto.conversationId,
      userId: user.id,
      lastReadAt: participant.lastReadAt?.toISOString() ?? dto.lastReadAt,
    });

    return { ok: true };
  }

  @SubscribeMessage('typing:start')
  async typingStart(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: ConversationEventDto,
  ) {
    const user = await this.authenticateClient(client);
    await this.messagingService.ensureParticipant(dto.conversationId, user.id);
    client.to(this.roomName(dto.conversationId)).emit('typing:started', {
      conversationId: dto.conversationId,
      userId: user.id,
    });
  }

  @SubscribeMessage('typing:stop')
  async typingStop(
    @ConnectedSocket() client: MessagingSocket,
    @MessageBody() dto: ConversationEventDto,
  ) {
    const user = await this.authenticateClient(client);
    await this.messagingService.ensureParticipant(dto.conversationId, user.id);
    client.to(this.roomName(dto.conversationId)).emit('typing:stopped', {
      conversationId: dto.conversationId,
      userId: user.id,
    });
  }

  private async authenticateClient(client: MessagingSocket) {
    if (client.data.user) {
      return client.data.user;
    }

    try {
      const token = this.getToken(client);
      if (!token) {
        throw new Error('Missing auth token');
      }

      const payload = await this.jwtService.verifyAsync<{ sub: string }>(token);
      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          phone: true,
          role: true,
          status: true,
        },
      });

      if (!user || user.status !== UserStatus.ACTIVE) {
        throw new Error('Inactive or missing user');
      }

      client.data.user = user;
      return user;
    } catch {
      client.emit('messaging:error', {
        code: 'UNAUTHORIZED',
        message: 'Messaging socket is not authenticated',
      });
      throw new Error('Unauthenticated socket');
    }
  }

  private getToken(client: Socket) {
    const authToken = client.handshake.auth.token;
    if (typeof authToken === 'string') {
      return authToken;
    }

    const header = client.handshake.headers.authorization;
    const [type, token] = header?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }

  private roomName(conversationId: string) {
    return `conversation:${conversationId}`;
  }
}
