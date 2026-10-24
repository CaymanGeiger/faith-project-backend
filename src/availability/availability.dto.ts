import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { AvailabilityMode } from './availability-policy';

class AvailabilityDayDto {
  @IsInt()
  @Min(0)
  @Max(6)
  day!: number;

  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  start!: string;

  @Matches(/^(?:[01]\d|2[0-3]):[0-5]\d$/)
  end!: string;
}

export class UpdateAvailabilityDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone!: string | null;

  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique((entry: AvailabilityDayDto) => entry.day)
  @ValidateNested({ each: true })
  @Type(() => AvailabilityDayDto)
  hours!: AvailabilityDayDto[];

  @IsIn(['SCHEDULE', 'AVAILABLE', 'AWAY'])
  mode!: AvailabilityMode;

  @IsOptional()
  @IsISO8601({ strict: true })
  overrideUntil!: string | null;

  @IsBoolean()
  silenceWhenUnavailable!: boolean;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500)
  outOfOfficeMessage?: string | null;
}
