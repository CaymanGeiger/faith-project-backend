/* eslint-disable @typescript-eslint/unbound-method -- These expectations inspect Jest mock call records, not unbound method invocation. */
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EquipmentService } from './equipment.service';

describe('EquipmentService', () => {
  it('returns a conflict when a serial number already exists', async () => {
    const tx = {
      equipmentRegistration: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockRejectedValue(uniqueConstraintError()),
      },
      todoItem: {
        updateMany: jest.fn(),
      },
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn((operation: (tx: unknown) => Promise<unknown>) =>
        operation(tx),
      ),
    } as unknown as PrismaService;

    const service = new EquipmentService(prisma);

    await expect(
      service.create('prospect-1', {
        equipmentName: 'LG Heat Pump',
        modelNumber: 'LHM-1',
        serialNumber: 'SERIAL-1',
      }),
    ).rejects.toThrow(ConflictException);
    await expect(
      service.create('prospect-1', {
        equipmentName: 'LG Heat Pump',
        modelNumber: 'LHM-1',
        serialNumber: 'SERIAL-1',
      }),
    ).rejects.toThrow(
      'This equipment serial number has already been registered.',
    );
    expect(prisma.todoItem.updateMany as jest.Mock).not.toHaveBeenCalled();
  });
});

function uniqueConstraintError() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['serialNumber'] },
  });
}
