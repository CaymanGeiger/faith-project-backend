import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CreateAccountDeletionRequestDto } from './dto/create-account-deletion-request.dto';
import { UsersService } from './users.service';

@ApiTags('account-deletion')
@Controller('account-deletion-requests')
export class AccountDeletionController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @Throttle({ default: { limit: 3, ttl: 60 * 60 * 1_000 } })
  request(@Body() dto: CreateAccountDeletionRequestDto) {
    return this.usersService.requestExternalAccountDeletion(dto.email);
  }
}
