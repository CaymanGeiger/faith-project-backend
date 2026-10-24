import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { isExternalHttpsUrl } from '../content/external-url';
import { financingInformation } from './financing';

@Injectable()
export class BenefitsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  financing() {
    return { financing: financingInformation(this.config) };
  }

  async list() {
    const benefits = await this.prisma.benefit.findMany({
      orderBy: { title: 'asc' },
    });

    return {
      benefits: benefits.filter((benefit) => isExternalHttpsUrl(benefit.url)),
    };
  }

  async findOne(id: string) {
    const benefit = await this.prisma.benefit.findUnique({ where: { id } });

    if (!benefit || !isExternalHttpsUrl(benefit.url)) {
      throw new NotFoundException('Benefit not found');
    }

    return { benefit };
  }
}
