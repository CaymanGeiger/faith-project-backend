import { IsEmail, MaxLength } from 'class-validator';

export class CreateAccountDeletionRequestDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;
}
