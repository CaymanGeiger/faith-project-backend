import { LeadRecordStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateLeadDto {
  @IsOptional()
  @IsEnum(LeadRecordStatus)
  status?: LeadRecordStatus;

  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  notes?: string;
}
