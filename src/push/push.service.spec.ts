import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from './push.service';

describe('Push delivery', () => {
  const original = process.env.PUSH_NOTIFICATIONS_ENABLED;
  const originalFetch = global.fetch;
  beforeEach(() => {
    process.env.PUSH_NOTIFICATIONS_ENABLED = 'true';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (original === undefined) delete process.env.PUSH_NOTIFICATIONS_ENABLED;
    else process.env.PUSH_NOTIFICATIONS_ENABLED = original;
  });

  function fixture() {
    const job = {
      id: 'job',
      deviceId: 'device',
      messageId: 'message',
      recipientId: 'recipient',
      status: 'PENDING',
      attempts: 0,
      receiptId: null as string | null,
      createdAt: new Date(),
    };
    const device = {
      id: 'device',
      token: 'ExpoPushToken[test]',
      userId: 'recipient',
      sessionVersion: 0,
      sessionExpiresAt: new Date(Date.now() + 100_000),
      user: {
        status: 'ACTIVE',
        sessionVersion: 0,
        salesManagerProfile: {
          availabilityTimezone: null,
          availabilityHours: [],
          availabilityMode: 'SCHEDULE',
          availabilityOverrideUntil: null,
          silenceWhenUnavailable: false,
        },
      },
    };
    const prisma = {
      pushDelivery: {
        findMany: jest.fn().mockResolvedValue([job]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        createMany: jest.fn(),
      },
      pushDevice: {
        findMany: jest.fn().mockResolvedValue([device]),
        findUnique: jest.fn().mockResolvedValue(device),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      message: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'message',
          senderId: 'sender',
          sender: { status: 'ACTIVE' },
          conversationId: 'chat',
          body: 'Private customer message',
          deletedAt: null,
          createdAt: new Date(),
        }),
      },
      conversationParticipant: {
        findUnique: jest.fn().mockResolvedValue({ lastReadAt: null }),
      },
      userBlock: { count: jest.fn().mockResolvedValue(0) },
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [{ status: 'ok', id: 'receipt' }] }),
    });
    return {
      job,
      device,
      prisma,
      service: new PushService(prisma as unknown as PrismaService),
    };
  }

  it('does not enqueue or contact Expo when disabled', async () => {
    const f = fixture();
    process.env.PUSH_NOTIFICATIONS_ENABLED = 'false';
    await f.service.enqueue({} as Prisma.TransactionClient, {
      id: 'message',
      senderId: 'sender',
      conversationId: 'chat',
    });
    await f.service.process();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.prisma.pushDelivery.findMany).not.toHaveBeenCalled();
  });
  it('sends generic text only and records a receipt for follow-up', async () => {
    const f = fixture();
    await f.service.process();
    const options = (fetch as jest.MockedFunction<typeof fetch>).mock
      .calls[0][1]!;
    expect(options.body).not.toContain('Private customer message');
    expect(
      (JSON.parse(options.body as string) as { data: unknown }[])[0].data,
    ).toEqual({
      type: 'chat',
      recipientId: 'recipient',
    });
    expect(f.prisma.pushDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RECEIPT',
          receiptId: 'receipt',
        }) as unknown,
      }),
    );
  });
  it('preserves registration preferences and records suppressed alerts without queuing them for later', async () => {
    const f = fixture();
    f.device.user.salesManagerProfile.availabilityMode = 'AWAY';
    f.device.user.salesManagerProfile.silenceWhenUnavailable = true;
    await f.service.enqueue(f.prisma as unknown as Prisma.TransactionClient, {
      id: 'message',
      senderId: 'sender',
      conversationId: 'chat',
    });
    expect(f.prisma.pushDelivery.createMany).toHaveBeenCalledWith({
      data: [
        {
          deviceId: 'device',
          recipientId: 'recipient',
          messageId: 'message',
          status: 'SUPPRESSED',
        },
      ],
      skipDuplicates: true,
    });
    expect(f.prisma.pushDevice.deleteMany).not.toHaveBeenCalled();
    f.prisma.pushDevice.findMany.mockResolvedValue([]);
    f.prisma.pushDelivery.createMany.mockClear();
    await f.service.enqueue(f.prisma as unknown as Prisma.TransactionClient, {
      id: 'another',
      senderId: 'sender',
      conversationId: 'chat',
    });
    expect(f.prisma.pushDelivery.createMany).not.toHaveBeenCalled();
  });
  it('rechecks quiet hours before sending a pending or retried alert', async () => {
    const f = fixture();
    f.device.user.salesManagerProfile.availabilityMode = 'AWAY';
    f.device.user.salesManagerProfile.silenceWhenUnavailable = true;
    f.job.attempts = 3;
    await f.service.process();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.prisma.pushDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: { status: 'SUPPRESSED', leaseUntil: null },
      }),
    );
  });
  it('leaves alerts enabled when the unavailable manager has not opted into silencing', async () => {
    const f = fixture();
    f.device.user.salesManagerProfile.availabilityMode = 'AWAY';
    await f.service.process();
    expect(fetch).toHaveBeenCalled();
  });
  it.each([
    'revoked',
    'disabled',
    'expired',
    'blocked',
    'deleted',
    'removed-member',
    'read',
  ])('does not notify a %s recipient/message', async (condition) => {
    const f = fixture();
    if (condition === 'revoked') f.device.user.sessionVersion = 1;
    if (condition === 'disabled') f.device.user.status = 'DISABLED';
    if (condition === 'expired') f.device.sessionExpiresAt = new Date(0);
    if (condition === 'blocked') f.prisma.userBlock.count.mockResolvedValue(1);
    if (condition === 'deleted')
      f.prisma.message.findUnique.mockResolvedValue(null);
    if (condition === 'removed-member')
      f.prisma.conversationParticipant.findUnique.mockResolvedValue(null);
    if (condition === 'read')
      f.prisma.conversationParticipant.findUnique.mockResolvedValue({
        lastReadAt: new Date(Date.now() + 1000),
      });
    await f.service.process();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('removes an unregistered device rather than retrying forever', async () => {
    const f = fixture();
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [
            { status: 'error', details: { error: 'DeviceNotRegistered' } },
          ],
        }),
    });
    await f.service.process();
    expect(f.prisma.pushDevice.deleteMany).toHaveBeenCalledWith({
      where: { id: 'device', token: 'ExpoPushToken[test]' },
    });
  });
  it('retries provider outages without failing or deleting the chat message', async () => {
    const f = fixture();
    (fetch as jest.Mock).mockRejectedValue(new Error('offline'));
    await f.service.process();
    expect(f.prisma.pushDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          attempts: 1,
          status: 'PENDING',
          leaseUntil: null,
        }) as unknown,
      }),
    );
  });
  it('polls receipts and marks successful delivery complete', async () => {
    const f = fixture();
    f.job.status = 'RECEIPT';
    f.job.receiptId = 'receipt';
    (fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { receipt: { status: 'ok' } } }),
    });
    await f.service.process();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('getReceipts'),
      expect.anything(),
    );
    expect(f.prisma.pushDelivery.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { status: 'DONE', leaseUntil: null } }),
    );
  });
});
