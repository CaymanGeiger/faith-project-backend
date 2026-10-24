import { DevelopmentTrainingGuard } from './development-training.guard';
import { DevelopmentTrainingController } from './development-training.controller';
import { DevelopmentTrainingService } from './development-training.service';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [OnboardingController, DevelopmentTrainingController],
  providers: [
    OnboardingService,
    DevelopmentTrainingService,
    DevelopmentTrainingGuard,
  ],
})
export class OnboardingModule {}
