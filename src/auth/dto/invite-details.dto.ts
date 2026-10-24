import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class InviteDetailsDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token!: string;
}
