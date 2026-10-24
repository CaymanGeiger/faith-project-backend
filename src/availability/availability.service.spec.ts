import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Reflector } from '@nestjs/core';
import { AvailabilityController } from './availability.controller';
import { AvailabilityService } from './availability.service';
import { UpdateAvailabilityDto } from './availability.dto';
import { PrismaService } from '../prisma/prisma.service';
import { ROLES_KEY } from '../auth/roles.decorator';
import { AFTER_HOURS_NOTICE } from './availability-policy';

describe('Availability ownership and validation', () => {
  const input = {
    timezone: 'America/Denver',
    hours: [{ day: 1, start: '09:00', end: '17:00' }],
    mode: 'SCHEDULE' as const,
    overrideUntil: null,
    silenceWhenUnavailable: false,
  };
  function fixture() {
    const prisma = {
      salesManagerProfile: {
        upsert: jest
          .fn()
          .mockImplementation(({ create }) => Promise.resolve(create)),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      conversationParticipant: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({
          userId: 'manager',
          user: { salesManagerProfile: null },
        }),
      },
    };
    return {
      prisma,
      service: new AvailabilityService(prisma as unknown as PrismaService),
    };
  }
  it('permits only managers to edit their own settings', async () => {
    const reflector = new Reflector();
    // Metadata inspection uses function identity without invoking these methods.

    expect(
      // eslint-disable-next-line @typescript-eslint/unbound-method
      reflector.get(ROLES_KEY, AvailabilityController.prototype.update),
    ).toEqual(['SALES_MANAGER']);

    expect(
      // eslint-disable-next-line @typescript-eslint/unbound-method
      reflector.get(ROLES_KEY, AvailabilityController.prototype.own),
    ).toEqual(['SALES_MANAGER']);
    const f = fixture();
    await f.service.update('current-manager', input);
    expect(f.prisma.salesManagerProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'current-manager' },
        create: expect.objectContaining({
          userId: 'current-manager',
        }) as unknown,
      }),
    );
  });
  it('requires conversation membership before exposing availability', async () => {
    const f = fixture();
    await expect(f.service.conversation('outsider', 'chat')).rejects.toThrow(
      'You cannot access',
    );
    expect(f.prisma.conversationParticipant.findFirst).not.toHaveBeenCalled();
    f.prisma.conversationParticipant.findUnique.mockResolvedValue({
      userId: 'dealer',
    });
    await expect(
      f.service.conversation('dealer', 'chat'),
    ).resolves.toMatchObject({
      managerId: 'manager',
      availability: { available: true },
    });
  });
  it('persists a trimmed custom message and returns it in settings and the away notice', async () => {
    const f = fixture();
    const result = await f.service.update('manager', {
      ...input,
      mode: 'AWAY',
      outOfOfficeMessage: '  Back on Monday.\nPlease contact the office.  ',
    });
    const outOfOfficeMessage = 'Back on Monday.\nPlease contact the office.';
    expect(f.prisma.salesManagerProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ outOfOfficeMessage }) as unknown,
        update: expect.objectContaining({ outOfOfficeMessage }) as unknown,
      }),
    );
    expect(result).toMatchObject({
      settings: { outOfOfficeMessage },
      availability: { available: false, notice: outOfOfficeMessage },
    });
  });
  it.each([null, '', '  \n '])(
    'clears a custom message when reset to %p',
    async (outOfOfficeMessage) => {
      const f = fixture();
      const result = await f.service.update('manager', {
        ...input,
        mode: 'AWAY',
        outOfOfficeMessage,
      });
      expect(f.prisma.salesManagerProfile.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            outOfOfficeMessage: null,
          }) as unknown,
        }),
      );
      expect(result).toMatchObject({
        settings: { outOfOfficeMessage: null },
        availability: { notice: AFTER_HOURS_NOTICE },
      });
    },
  );
  it('preserves the saved message when an older client omits it', async () => {
    const f = fixture();
    const outOfOfficeMessage = 'Back tomorrow.';
    f.prisma.salesManagerProfile.upsert.mockImplementation(({ update }) =>
      Promise.resolve({ outOfOfficeMessage, ...update }),
    );
    const result = await f.service.update('manager', {
      ...input,
      mode: 'AWAY',
    });
    expect(f.prisma.salesManagerProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({
          outOfOfficeMessage: expect.anything() as unknown,
        }) as unknown,
      }),
    );
    expect(result).toMatchObject({
      settings: { outOfOfficeMessage },
      availability: { notice: outOfOfficeMessage },
    });
  });
  it('returns the default message setting when no profile exists', async () => {
    const f = fixture();
    await expect(f.service.ownSettings('manager')).resolves.toMatchObject({
      settings: { outOfOfficeMessage: null },
    });
  });
  it('rejects invalid timezones, ambiguous equal times, and expired overrides', async () => {
    const f = fixture();
    await expect(
      f.service.update('manager', { ...input, timezone: 'Not/AZone' }),
    ).rejects.toThrow('valid time zone');
    await expect(
      f.service.update('manager', { ...input, timezone: null }),
    ).rejects.toThrow('time zone is required');
    await expect(
      f.service.update('manager', {
        ...input,
        hours: [{ day: 1, start: '09:00', end: '09:00' }],
      }),
    ).rejects.toThrow('must be different');
    await expect(
      f.service.update('manager', {
        ...input,
        mode: 'AWAY',
        overrideUntil: '2020-01-01T00:00:00Z',
      }),
    ).rejects.toThrow('future');
    expect(f.prisma.salesManagerProfile.upsert).not.toHaveBeenCalled();
  });
  it('rejects out-of-range days, duplicate days, malformed times, and unsupported modes', async () => {
    for (const invalid of [
      { ...input, hours: [{ day: 7, start: '09:00', end: '17:00' }] },
      { ...input, hours: [...input.hours, ...input.hours] },
      { ...input, hours: [{ day: 1, start: '24:00', end: '17:00' }] },
      { ...input, mode: 'BLOCK' },
    ]) {
      expect(
        (await validate(plainToInstance(UpdateAvailabilityDto, invalid)))
          .length,
      ).toBeGreaterThan(0);
    }
    expect(
      await validate(plainToInstance(UpdateAvailabilityDto, input)),
    ).toEqual([]);
  });
  it('validates message type and length after trimming without requiring older clients to send it', async () => {
    for (const outOfOfficeMessage of [
      123,
      false,
      {},
      ['Away'],
      'a'.repeat(501),
    ]) {
      expect(
        (
          await validate(
            plainToInstance(UpdateAvailabilityDto, {
              ...input,
              outOfOfficeMessage,
            }),
          )
        ).map((error) => error.property),
      ).toContain('outOfOfficeMessage');
    }
    for (const outOfOfficeMessage of [
      undefined,
      null,
      '',
      '  ',
      'a'.repeat(500),
    ]) {
      expect(
        await validate(
          plainToInstance(UpdateAvailabilityDto, {
            ...input,
            outOfOfficeMessage,
          }),
        ),
      ).toEqual([]);
    }
    const dto = plainToInstance(UpdateAvailabilityDto, {
      ...input,
      outOfOfficeMessage: `  ${'a'.repeat(500)}  `,
    });
    expect(await validate(dto)).toEqual([]);
    expect(dto.outOfOfficeMessage).toBe('a'.repeat(500));
  });
});
