import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ClassesController } from './classes.controller';
import { ClassesService } from './classes.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [ClassesController],
  providers: [ClassesService],
})
export class ClassesModule {}
