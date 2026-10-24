import { AllowBeforeTraining } from '../onboarding/onboarding-access';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { MessageHistoryQueryDto, ReportMessageDto } from './dto/messaging.dto';
import { MessagingService } from './messaging.service';

@ApiTags('messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PROSPECT, UserRole.SALES_MANAGER)
@AllowBeforeTraining()
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

  @Post(':conversationId/messages/:messageId/report')
  @Throttle({ default: { limit: 10, ttl: 60 * 60 * 1_000 } })
  reportMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() dto: ReportMessageDto,
  ) {
    return this.messagingService.reportMessage(
      user.id,
      conversationId,
      messageId,
      dto.reason,
    );
  }

  @Post(':conversationId/block')
  blockParticipant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
  ) {
    return this.messagingService.blockParticipant(user.id, conversationId);
  }

  @Delete(':conversationId/block')
  unblockParticipant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') conversationId: string,
  ) {
    return this.messagingService.unblockParticipant(user.id, conversationId);
  }
}
