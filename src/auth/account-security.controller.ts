import { AllowBeforeTraining } from '../onboarding/onboarding-access';
import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AccountSecurityService } from './account-security.service';
import { CurrentUser } from './current-user.decorator';
import type { AuthenticatedUser } from './authenticated-user';
import { JwtAuthGuard } from './jwt-auth.guard';
import {
  EmailChangeConfirmDto,
  ActivationConfirmDto,
  EmailChangeRequestDto,
  RecoveryConfirmDto,
  RecoveryRequestDto,
} from './security.dto';

@AllowBeforeTraining()
@Controller('auth')
@Throttle({ default: { limit: 5, ttl: 60_000 } })
export class AccountSecurityController {
  constructor(private readonly security: AccountSecurityService) {}
  @Post('activation/request')
  requestActivation(@Body() dto: RecoveryRequestDto) {
    return this.security.requestActivation(dto.email);
  }
  @Post('activation/confirm')
  confirmActivation(@Body() dto: ActivationConfirmDto) {
    return this.security.confirmActivation(dto);
  }
  @Post('password-recovery')
  requestRecovery(@Body() dto: RecoveryRequestDto) {
    return this.security.requestRecovery(dto.email);
  }
  @Post('password-recovery/confirm')
  confirmRecovery(@Body() dto: RecoveryConfirmDto) {
    return this.security.confirmRecovery(dto);
  }
  @UseGuards(JwtAuthGuard)
  @Post('email-change')
  requestEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EmailChangeRequestDto,
  ) {
    return this.security.requestEmailChange(user.id, dto);
  }
  @UseGuards(JwtAuthGuard)
  @Post('email-change/confirm')
  confirmEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: EmailChangeConfirmDto,
  ) {
    return this.security.confirmEmailChange(user.id, dto.code);
  }
}
