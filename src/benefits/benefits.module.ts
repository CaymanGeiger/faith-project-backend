import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { BenefitsController } from './benefits.controller';
import { BenefitsService } from './benefits.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [BenefitsController],
  providers: [BenefitsService],
})
export class BenefitsModule {}
