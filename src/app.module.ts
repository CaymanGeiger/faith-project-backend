import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BenefitsModule } from './benefits/benefits.module';
import { ClassesModule } from './classes/classes.module';
import { EquipmentModule } from './equipment/equipment.module';
import { LeadsModule } from './leads/leads.module';
import { MarketingConsultationModule } from './marketing-consultation/marketing-consultation.module';
import { MessagingModule } from './messaging/messaging.module';
import { PrismaModule } from './prisma/prisma.module';
import { ResourcesModule } from './resources/resources.module';
import { TodosModule } from './todos/todos.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    UsersModule,
    ClassesModule,
    EquipmentModule,
    ResourcesModule,
    TodosModule,
    BenefitsModule,
    MarketingConsultationModule,
    LeadsModule,
    MessagingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
