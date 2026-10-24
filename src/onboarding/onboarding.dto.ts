import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class VerifyInitialTrainingDto {
  @IsISO8601({ strict: true })
  completedAt!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  source!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reference!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  enrollmentId?: string;
}
