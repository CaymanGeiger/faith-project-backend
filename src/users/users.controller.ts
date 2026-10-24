import { AllowBeforeTraining } from '../onboarding/onboarding-access';
import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateMeDto } from './dto/update-me.dto';
import { UsersService } from './users.service';

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@AllowBeforeTraining()
@Controller('me')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getMe(user);
  }

  @Patch()
  updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateMeDto) {
    return this.usersService.updateMe(user, dto);
  }

  @Patch('legal-acceptance')
  acceptLegalTerms(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.acceptLegalTerms(user);
  }

  @Post('account-deletion-request')
  requestAccountDeletion(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.requestAccountDeletion(user);
  }

  @Roles(UserRole.PROSPECT)
  @Get('onboarding-status')
  getOnboardingStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.getOnboardingStatus(user);
  }
}
