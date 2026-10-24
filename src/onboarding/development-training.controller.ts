import { DevelopmentTrainingGuard } from './development-training.guard';
import { Body, Controller, Patch, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { IsBoolean } from 'class-validator';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { AllowBeforeTraining } from './onboarding-access';
import { DevelopmentTrainingService } from './development-training.service';

class DevelopmentTrainingDto {
  @IsBoolean()
  completed!: boolean;
}

@AllowBeforeTraining()
@UseGuards(DevelopmentTrainingGuard, JwtAuthGuard, RolesGuard)
@Roles(UserRole.PROSPECT)
@Controller('onboarding/development')
export class DevelopmentTrainingController {
  constructor(private readonly service: DevelopmentTrainingService) {}
  @Patch('training')
  setTraining(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DevelopmentTrainingDto,
  ) {
    return this.service.setTraining(user.id, dto.completed);
  }
}
