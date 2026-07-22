import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BenefitsService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const benefits = await this.prisma.benefit.findMany({
      orderBy: { title: 'asc' },
    });

    return { benefits };
  }

  async findOne(id: string) {
    const benefit = await this.prisma.benefit.findUnique({ where: { id } });

    if (!benefit) {
      throw new NotFoundException('Benefit not found');
    }

    return { benefit };
  }
}
