import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LeadApiAdapter } from './lead-api.adapter';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [LeadsController],
  providers: [LeadsService, LeadApiAdapter],
})
export class LeadsModule {}
