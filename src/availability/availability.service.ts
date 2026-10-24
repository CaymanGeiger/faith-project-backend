import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateAvailabilityDto } from './availability.dto';
import {
  AvailabilitySettings,
  evaluateAvailability,
} from './availability-policy';

type StoredSettings = {
  availabilityTimezone: string | null;
  availabilityHours: Prisma.JsonValue | null;
  availabilityMode: string;
  availabilityOverrideUntil: Date | null;
  silenceWhenUnavailable: boolean;
  outOfOfficeMessage: string | null;
};

export function readAvailabilitySettings(
  profile: StoredSettings | null,
): AvailabilitySettings {
  return {
    timezone: profile?.availabilityTimezone ?? null,
    hours: (profile?.availabilityHours as AvailabilitySettings['hours']) ?? [],
    mode:
      (profile?.availabilityMode as AvailabilitySettings['mode']) ?? 'SCHEDULE',
    overrideUntil: profile?.availabilityOverrideUntil ?? null,
    silenceWhenUnavailable: profile?.silenceWhenUnavailable ?? false,
    outOfOfficeMessage: profile?.outOfOfficeMessage ?? null,
  };
}

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async ownSettings(userId: string) {
    const profile = await this.prisma.salesManagerProfile.findUnique({
      where: { userId },
    });
    const settings = readAvailabilitySettings(profile);
    return { settings, availability: evaluateAvailability(settings) };
  }

  async update(userId: string, dto: UpdateAvailabilityDto) {
    const timezone = dto.timezone?.trim() || null;
    if (timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
      } catch {
        throw new BadRequestException(
          'Choose a valid time zone, such as America/Denver.',
        );
      }
    } else if (dto.hours.length) {
      throw new BadRequestException(
        'A time zone is required when setting hours.',
      );
    }
    if (dto.hours.some((hours) => hours.start === hours.end))
      throw new BadRequestException(
        'Opening and closing times must be different.',
      );
    const overrideUntil = dto.overrideUntil
      ? new Date(dto.overrideUntil)
      : null;
    if (
      overrideUntil &&
      (dto.mode === 'SCHEDULE' || overrideUntil <= new Date())
    )
      throw new BadRequestException(
        'A temporary override must end in the future.',
      );
    const data = {
      availabilityTimezone: timezone,
      availabilityHours: dto.hours.map(({ day, start, end }) => ({
        day,
        start,
        end,
      })),
      availabilityMode: dto.mode,
      availabilityOverrideUntil: overrideUntil,
      silenceWhenUnavailable: dto.silenceWhenUnavailable,
      ...(dto.outOfOfficeMessage !== undefined
        ? { outOfOfficeMessage: dto.outOfOfficeMessage?.trim() || null }
        : {}),
    };
    const profile = await this.prisma.salesManagerProfile.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
    const settings = readAvailabilitySettings(profile);
    return { settings, availability: evaluateAvailability(settings) };
  }

  async conversation(userId: string, conversationId: string) {
    const membership = await this.prisma.conversationParticipant.findUnique({
      where: { conversationId_userId: { conversationId, userId } },
    });
    if (!membership)
      throw new ForbiddenException('You cannot access this conversation');
    const manager = await this.prisma.conversationParticipant.findFirst({
      where: {
        conversationId,
        user: { role: 'SALES_MANAGER', status: 'ACTIVE' },
      },
      select: { userId: true, user: { select: { salesManagerProfile: true } } },
    });
    return {
      managerId: manager?.userId ?? null,
      availability: manager
        ? evaluateAvailability(
            readAvailabilitySettings(manager.user.salesManagerProfile),
          )
        : null,
    };
  }
}
