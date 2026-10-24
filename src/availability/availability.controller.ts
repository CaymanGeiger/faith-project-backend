import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateAvailabilityDto } from './availability.dto';
import { AvailabilityService } from './availability.service';
import { AllowBeforeTraining } from '../onboarding/onboarding-access';

@Controller('availability')
@UseGuards(JwtAuthGuard, RolesGuard)
@AllowBeforeTraining()
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('me')
  @Roles('SALES_MANAGER')
  own(@CurrentUser() user: AuthenticatedUser) {
    return this.availability.ownSettings(user.id);
  }

  @Put('me')
  @Roles('SALES_MANAGER')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.availability.update(user.id, dto);
  }

  @Get('conversations/:conversationId')
  conversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('conversationId') id: string,
  ) {
    return this.availability.conversation(user.id, id);
  }
}
