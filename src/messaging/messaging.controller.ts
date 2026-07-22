import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { MessageHistoryQueryDto } from './dto/messaging.dto';
import { MessagingService } from './messaging.service';

@ApiTags('messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PROSPECT, UserRole.SALES_MANAGER)
@Controller('conversations')
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.messagingService.listConversations(user.id);
  }

  @Get(':conversationId')
  getConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
  ) {
    return this.messagingService.getConversation(user.id, conversationId);
  }

  @Get(':conversationId/messages')
  getMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
    @Query() query: MessageHistoryQueryDto,
  ) {
    return this.messagingService.getMessages(
      user.id,
      conversationId,
      query.cursor,
    );
  }
}
