import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/authenticated-user';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { MarketingHandoffDto } from './dto/marketing-handoff.dto';
import { MarketingConsultationService } from './marketing-consultation.service';

@ApiTags('marketing-consultation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.PROSPECT)
@Controller('me/marketing-consultation')
export class MarketingConsultationController {
  constructor(
    private readonly marketingConsultationService: MarketingConsultationService,
  ) {}

  @Get()
  getForProspect(@CurrentUser() user: AuthenticatedUser) {
    return this.marketingConsultationService.getForProspect(user.id);
  }

  @Post('handoff')
  submitHandoff(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: MarketingHandoffDto,
  ) {
    return this.marketingConsultationService.submitHandoff(user.id, dto);
  }
}
