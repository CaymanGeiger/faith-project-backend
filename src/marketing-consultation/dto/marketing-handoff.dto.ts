import { IsNotEmpty, IsString } from 'class-validator';

export class MarketingHandoffDto {
  @IsString()
  @IsNotEmpty()
  availabilityOptionOne!: string;

  @IsString()
  @IsNotEmpty()
  availabilityOptionTwo!: string;

  @IsString()
  @IsNotEmpty()
  availabilityOptionThree!: string;
}
