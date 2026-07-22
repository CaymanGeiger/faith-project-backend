import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LeadApiAdapter } from './lead-api.adapter';
import { UpdateLeadDto } from './dto/update-lead.dto';

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadApiAdapter: LeadApiAdapter,
  ) {}

  async listAssignedProspects(managerUserId: string) {
    const prospects = await this.prisma.prospectProfile.findMany({
      where: { assignedSalesManagerId: managerUserId },
      orderBy: { signupDate: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            status: true,
          },
        },
      },
    });

    return { prospects };
  }

  async getAssignedProspect(managerUserId: string, prospectUserId: string) {
    const profile = await this.prisma.prospectProfile.findUnique({
      where: { userId: prospectUserId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            status: true,
          },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException('Prospect not found');
    }

    this.assertAssigned(profile.assignedSalesManagerId, managerUserId);
    return { prospect: profile };
  }

  async getLead(managerUserId: string, prospectUserId: string) {
    await this.getAssignedProspect(managerUserId, prospectUserId);

    const lead = await this.prisma.leadRecord.findUnique({
      where: { prospectUserId },
    });

    if (!lead) {
      throw new NotFoundException('Lead record not found');
    }

    return { lead };
  }

  async updateLead(
    managerUserId: string,
    prospectUserId: string,
    dto: UpdateLeadDto,
  ) {
    const { lead } = await this.getLead(managerUserId, prospectUserId);
    const sync = await this.leadApiAdapter.syncLeadUpdate(
      lead.externalLeadId,
      dto,
    );

    const updatedLead = await this.prisma.leadRecord.update({
      where: { id: lead.id },
      data: {
        status: dto.status,
        notes: dto.notes,
      },
    });

    return { lead: updatedLead, sync };
  }

  private assertAssigned(assignedSalesManagerId: string, managerUserId: string) {
    if (assignedSalesManagerId !== managerUserId) {
      throw new ForbiddenException('Prospect is not assigned to this manager');
    }
  }
}
