import { Injectable } from '@nestjs/common';
import { TodoItemStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MarketingHandoffDto } from './dto/marketing-handoff.dto';
import { LeadSmartAdapter } from './lead-smart.adapter';

@Injectable()
export class MarketingConsultationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly leadSmartAdapter: LeadSmartAdapter,
  ) {}

  async getForProspect(prospectUserId: string) {
    const consultation = await this.prisma.marketingConsultation.upsert({
      where: { prospectUserId },
      update: {},
      create: { prospectUserId },
    });

    return { consultation };
  }

  async submitHandoff(prospectUserId: string, dto: MarketingHandoffDto) {
    const handoff = await this.leadSmartAdapter.submit(prospectUserId, dto);
    const now = new Date();

    const consultation = await this.prisma.$transaction(async (tx) => {
      const savedConsultation = await tx.marketingConsultation.upsert({
        where: { prospectUserId },
        update: {
          availabilityOptionOne: dto.availabilityOptionOne,
          availabilityOptionTwo: dto.availabilityOptionTwo,
          availabilityOptionThree: dto.availabilityOptionThree,
          externalSubmissionStatus: handoff.externalSubmissionStatus,
          submittedAt: now,
        },
        create: {
          prospectUserId,
          availabilityOptionOne: dto.availabilityOptionOne,
          availabilityOptionTwo: dto.availabilityOptionTwo,
          availabilityOptionThree: dto.availabilityOptionThree,
          externalSubmissionStatus: handoff.externalSubmissionStatus,
          submittedAt: now,
        },
      });

      await tx.todoItem.updateMany({
        where: {
          prospectUserId,
          type: 'MARKETING_CONSULTATION',
          completedAt: null,
        },
        data: { status: TodoItemStatus.COMPLETED, completedAt: now },
      });

      return savedConsultation;
    });

    return { consultation, handoff };
  }
}
