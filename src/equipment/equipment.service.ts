import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isPrismaUniqueConstraintError } from '../prisma/prisma-error';
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
    const data = this.normalized(dto);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const existing = await tx.equipmentRegistration.findUnique({
          where: { serialNumber: data.serialNumber },
        });
        if (
          existing &&
          (existing.prospectUserId !== prospectUserId ||
            existing.equipmentName !== data.equipmentName ||
            existing.modelNumber !== data.modelNumber)
        ) {
          throw new ConflictException(
            'This equipment serial number has already been registered.',
          );
        }
        const equipment =
          existing ??
          (await tx.equipmentRegistration.create({
            data: { prospectUserId, ...data },
          }));
        await tx.todoItem.updateMany({
          where: {
            prospectUserId,
            type: 'EQUIPMENT_REGISTRATION',
            completedAt: null,
          },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
        return { equipment };
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error, 'serialNumber')) {
        // A retry racing the original request may find the committed record.
        const existing = await this.prisma.equipmentRegistration.findUnique({
          where: { serialNumber: data.serialNumber },
        });
        if (
          existing?.prospectUserId === prospectUserId &&
          existing.equipmentName === data.equipmentName &&
          existing.modelNumber === data.modelNumber
        )
          return { equipment: existing };
        throw new ConflictException(
          'This equipment serial number has already been registered.',
        );
      }
      throw error;
    }
  }

  async update(
    prospectUserId: string,
    id: string,
    dto: CreateEquipmentRegistrationDto,
  ) {
    const data = this.normalized(dto);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "EquipmentRegistration" WHERE "id" = ${id} FOR UPDATE`;
        const existing = await tx.equipmentRegistration.findFirst({
          where: { id, prospectUserId },
        });
        if (!existing)
          throw new NotFoundException('Equipment registration not found');
        if (existing.status === 'APPROVED')
          throw new ConflictException(
            'Contact Hercules to correct an approved equipment record.',
          );
        const equipment = await tx.equipmentRegistration.update({
          where: { id },
          data,
        });
        return { equipment };
      });
    } catch (error) {
      if (isPrismaUniqueConstraintError(error, 'serialNumber'))
        throw new ConflictException(
          'This equipment serial number has already been registered.',
        );
      throw error;
    }
  }

  private normalized(dto: CreateEquipmentRegistrationDto) {
    const data = {
      equipmentName: dto.equipmentName.trim(),
      modelNumber: dto.modelNumber.trim(),
      serialNumber: dto.serialNumber.trim(),
    };
    if (Object.values(data).some((value) => !value))
      throw new BadRequestException(
        'Equipment name, model and serial number are required.',
      );
    return data;
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
