import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { BenefitsService } from './benefits.service';

@ApiTags('benefits')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PROSPECT, UserRole.SALES_MANAGER)
@Controller('benefits')
export class BenefitsController {
  constructor(private readonly benefitsService: BenefitsService) {}

  @Get()
  list() {
    return this.benefitsService.list();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.benefitsService.findOne(id);
  }
}
