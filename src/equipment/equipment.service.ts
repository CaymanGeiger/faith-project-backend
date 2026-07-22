import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEquipmentRegistrationDto } from './dto/create-equipment-registration.dto';

@Injectable()
export class EquipmentService {
  constructor(private readonly prisma: PrismaService) {}

  async list(prospectUserId: string) {
    const equipment = await this.prisma.equipmentRegistration.findMany({
      where: { prospectUserId },
      orderBy: { createdAt: 'desc' },
    });

    return { equipment };
  }

  async create(prospectUserId: string, dto: CreateEquipmentRegistrationDto) {
    const equipment = await this.prisma.equipmentRegistration.create({
      data: {
        prospectUserId,
        equipmentName: dto.equipmentName,
        modelNumber: dto.modelNumber,
        serialNumber: dto.serialNumber,
      },
    });

    await this.prisma.todoItem.updateMany({
      where: {
        prospectUserId,
        type: 'EQUIPMENT_REGISTRATION',
        completedAt: null,
      },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    return { equipment };
  }

  async findOne(prospectUserId: string, id: string) {
    const equipment = await this.prisma.equipmentRegistration.findFirst({
      where: { id, prospectUserId },
    });

    if (!equipment) {
      throw new NotFoundException('Equipment registration not found');
    }

    return { equipment };
  }
}
