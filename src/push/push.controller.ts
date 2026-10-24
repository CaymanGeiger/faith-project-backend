import { AllowBeforeTraining } from '../onboarding/onboarding-access';
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PushService } from './push.service';

class PushTokenDto {
  @IsString()
  @MaxLength(256)
  @Matches(/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/)
  token!: string;
}
class PushRegistrationDto extends PushTokenDto {
  @IsIn(['ios', 'android'])
  platform!: string;
}

@AllowBeforeTraining()
@Controller('push')
@UseGuards(JwtAuthGuard)
export class PushController {
  constructor(private readonly push: PushService) {}
  @Get('status')
  status() {
    return { available: this.push.enabled() };
  }
  @Post('register')
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PushRegistrationDto,
  ) {
    return this.push.register(user, dto.token, dto.platform);
  }
  @Post('unregister')
  unregister(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PushTokenDto,
  ) {
    return this.push.unregister(user.id, dto.token);
  }
}
