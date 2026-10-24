import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { VerifyInitialTrainingDto } from './onboarding.dto';
import { OnboardingService } from './onboarding.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SALES_MANAGER)
@Controller('onboarding/prospects')
export class OnboardingController {
  constructor(private readonly service: OnboardingService) {}
  @Get(':id')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.service.getForManager(user.id, id);
  }
  @Post(':id/training-verification')
  verify(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VerifyInitialTrainingDto,
  ) {
    return this.service.verifyInitialTraining(user.id, id, dto);
  }
}
