import { OnboardingModule } from './onboarding/onboarding.module';
import { ReadinessController } from './readiness.controller';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BenefitsModule } from './benefits/benefits.module';
import { ClassesModule } from './classes/classes.module';
import { EquipmentModule } from './equipment/equipment.module';
import { LeadsModule } from './leads/leads.module';
import { JotformModule } from './jotform/jotform.module';
import { MarketingConsultationModule } from './marketing-consultation/marketing-consultation.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { ResourcesModule } from './resources/resources.module';
import { TodosModule } from './todos/todos.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 120,
      },
    ]),
    PrismaModule,
    AuthModule,
    OnboardingModule,
    UsersModule,
    ClassesModule,
    EquipmentModule,
    ResourcesModule,
    TodosModule,
    BenefitsModule,
    MarketingConsultationModule,
    LeadsModule,
    JotformModule,
    MessagingModule,
  ],
  controllers: [AppController, ReadinessController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
