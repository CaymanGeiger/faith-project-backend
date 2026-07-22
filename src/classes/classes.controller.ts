import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ClassesService } from './classes.service';

@ApiTags('classes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class ClassesController {
  constructor(private readonly classesService: ClassesService) {}

  @Roles(UserRole.PROSPECT, UserRole.SALES_MANAGER)
  @Get('classes')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.classesService.list(user);
  }

  @Roles(UserRole.PROSPECT, UserRole.SALES_MANAGER)
  @Get('classes/:id')
  findOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.classesService.findOne(id, user);
  }

  @Roles(UserRole.PROSPECT)
  @Post('classes/:id/enroll')
  enroll(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.classesService.enroll(id, user);
  }

  @Roles(UserRole.PROSPECT)
  @Get('me/classes')
  myEnrollments(@CurrentUser() user: AuthenticatedUser) {
    return this.classesService.myEnrollments(user);
  }
}
