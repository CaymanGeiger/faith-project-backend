import { IsNotEmpty, IsString } from 'class-validator';

export class InviteDetailsDto {
  @IsString()
  @IsNotEmpty()
  token!: string;
}
