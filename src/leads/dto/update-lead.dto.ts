import { LeadRecordStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateLeadDto {
  @IsOptional()
  @IsEnum(LeadRecordStatus)
  status?: LeadRecordStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}
