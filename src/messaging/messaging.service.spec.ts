/* eslint-disable @typescript-eslint/unbound-method -- These expectations inspect Jest mock call records, not unbound method invocation. */
import { BadRequestException, HttpException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { CURRENT_TERMS_VERSION } from '../legal/legal.constants';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingService } from './messaging.service';

describe('MessagingService', () => {
  const previousBlockedTerms = process.env.MESSAGE_BLOCKED_TERMS;

  afterEach(() => {
    if (previousBlockedTerms === undefined) {
      delete process.env.MESSAGE_BLOCKED_TERMS;
    } else {
      process.env.MESSAGE_BLOCKED_TERMS = previousBlockedTerms;
    }
  });

  function makePrisma(sentInLastMinute = 0) {
    return {
      conversationParticipant: {
        findUnique: jest.fn().mockResolvedValue({ userId: 'dealer-1' }),
        findMany: jest
          .fn()
          .mockImplementation(({ select }: { select?: { user?: unknown } }) => {
            if (select?.user) {
              return Promise.resolve([
                { user: { status: UserStatus.ACTIVE } },
                { user: { status: UserStatus.ACTIVE } },
              ]);
            }
            return Promise.resolve([
              { userId: 'dealer-1' },
              { userId: 'manager-1' },
            ]);
          }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          termsAcceptedAt: new Date('2026-08-17T00:00:00.000Z'),
          termsVersion: CURRENT_TERMS_VERSION,
        }),
      },
      userBlock: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      message: {
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(sentInLastMinute),
      },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
  }

  it('rejects a message containing an approved blocked term before it reaches storage', async () => {
    process.env.MESSAGE_BLOCKED_TERMS = 'forbidden phrase';
    const prisma = makePrisma();
    const service = new MessagingService(prisma);

    await expect(
      service.sendMessage('dealer-1', {
        conversationId: 'conversation-1',
        clientMessageId: 'client-message-1',
        body: 'Please include a Forbidden Phrase in this message.',
      }),
    ).rejects.toThrow(
      new BadRequestException(
        'This message includes content that is not permitted in Hercules Honors Rewards',
      ),
    );
    expect(prisma.message.findUnique as jest.Mock).not.toHaveBeenCalled();
    expect(prisma.$transaction as jest.Mock).not.toHaveBeenCalled();
  });

  it('rate limits message sends before writing a new message', async () => {
    const prisma = makePrisma(30);
    const service = new MessagingService(prisma);

    try {
      await service.sendMessage('dealer-1', {
        conversationId: 'conversation-1',
        clientMessageId: 'client-message-1',
        body: 'Could you help with this dealer question?',
      });
      fail('Expected message rate limiting to reject the request');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).message).toBe(
        'You are sending messages too quickly. Please wait a moment and try again.',
      );
    }
    expect(prisma.$transaction as jest.Mock).not.toHaveBeenCalled();
  });
});
