import { IsNotEmpty, IsString } from 'class-validator';

export class CreateEquipmentRegistrationDto {
  @IsString()
  @IsNotEmpty()
  equipmentName!: string;

  @IsString()
  @IsNotEmpty()
  modelNumber!: string;

  @IsString()
  @IsNotEmpty()
  serialNumber!: string;
}
