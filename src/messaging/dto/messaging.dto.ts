import {
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class ConversationEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  conversationId!: string;
}

export class SendMessageDto extends ConversationEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  clientMessageId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2_000)
  body!: string;
}

export class MarkReadDto extends ConversationEventDto {
  @IsISO8601()
  lastReadAt!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  lastMessageId?: string;
}

export class MessageHistoryQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  cursor?: string;
}

export class ReportMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
