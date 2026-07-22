import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LeadSmartAdapter } from './lead-smart.adapter';
import { MarketingConsultationController } from './marketing-consultation.controller';
import { MarketingConsultationService } from './marketing-consultation.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [MarketingConsultationController],
  providers: [MarketingConsultationService, LeadSmartAdapter],
})
export class MarketingConsultationModule {}
