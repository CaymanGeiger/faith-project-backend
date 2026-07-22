import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { LeadsService } from './leads.service';

@ApiTags('manager')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SALES_MANAGER)
@Controller('manager/prospects')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  listAssignedProspects(@CurrentUser() user: AuthenticatedUser) {
    return this.leadsService.listAssignedProspects(user.id);
  }

  @Get(':prospectUserId')
  getAssignedProspect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('prospectUserId') prospectUserId: string,
  ) {
    return this.leadsService.getAssignedProspect(user.id, prospectUserId);
  }

  @Get(':prospectUserId/lead')
  getLead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('prospectUserId') prospectUserId: string,
  ) {
    return this.leadsService.getLead(user.id, prospectUserId);
  }

  @Patch(':prospectUserId/lead')
  updateLead(
    @CurrentUser() user: AuthenticatedUser,
    @Param('prospectUserId') prospectUserId: string,
    @Body() dto: UpdateLeadDto,
  ) {
    return this.leadsService.updateLead(user.id, prospectUserId, dto);
  }
}
