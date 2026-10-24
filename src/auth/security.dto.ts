import { Transform } from 'class-transformer';
import {
  IsEmail,
  Equals,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RecoveryRequestDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class RecoveryConfirmDto extends RecoveryRequestDto {
  @IsString()
  @Matches(/^\d{8}$/)
  code!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(72)
  password!: string;
}

export class EmailChangeRequestDto extends RecoveryRequestDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;
}

export class EmailChangeConfirmDto {
  @IsString()
  @Matches(/^\d{8}$/)
  code!: string;
}

export class ActivationConfirmDto extends RecoveryConfirmDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName!: string;

  @Equals(true)
  termsAccepted!: true;
}
