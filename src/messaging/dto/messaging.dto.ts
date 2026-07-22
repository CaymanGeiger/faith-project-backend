import { IsISO8601, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ConversationEventDto {
  @IsString()
  @IsNotEmpty()
  conversationId!: string;
}

export class SendMessageDto extends ConversationEventDto {
  @IsString()
  @IsNotEmpty()
  clientMessageId!: string;

  @IsString()
  @IsNotEmpty()
  body!: string;
}

export class MarkReadDto extends ConversationEventDto {
  @IsISO8601()
  lastReadAt!: string;
}

export class MessageHistoryQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;
}
