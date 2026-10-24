import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class MarketingHandoffDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  availabilityOptionOne!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  availabilityOptionTwo!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  availabilityOptionThree!: string;
}
