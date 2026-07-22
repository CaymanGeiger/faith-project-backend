import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class ResourcesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const resources = await this.prisma.resource.findMany({
      orderBy: [{ category: 'asc' }, { title: 'asc' }],
    });

    return { resources };
  }

  async findOne(id: string) {
    const resource = await this.prisma.resource.findUnique({ where: { id } });

    if (!resource) {
      throw new NotFoundException('Resource not found');
    }

    return { resource };
  }
}
