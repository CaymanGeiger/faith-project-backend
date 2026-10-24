import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateEquipmentRegistrationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  equipmentName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  modelNumber!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  serialNumber!: string;
}
