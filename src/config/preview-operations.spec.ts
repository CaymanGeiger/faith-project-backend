import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from '../auth/authenticated-user';
import { MessagingService } from '../messaging/messaging.service';
import { UsersService } from '../users/users.service';
import { assertPreviewOperationsConfigured } from './preview-operations';

describe('Unconfigured preview operations', () => {
  const savedApp = process.env.APP_ENV;
  const savedWebhook = process.env.OPERATIONS_WEBHOOK_URL;
  beforeEach(() => {
    process.env.APP_ENV = 'preview';
    delete process.env.OPERATIONS_WEBHOOK_URL;
  });
  afterEach(() => {
    if (savedApp === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = savedApp;
    if (savedWebhook === undefined) delete process.env.OPERATIONS_WEBHOOK_URL;
    else process.env.OPERATIONS_WEBHOOK_URL = savedWebhook;
  });
  it('reports clear unavailability before creating a moderation report', async () => {
    const upsert = jest.fn();
    const service = new MessagingService({
      conversationParticipant: { findUnique: jest.fn().mockResolvedValue({}) },
      messageReport: { upsert },
    } as unknown as PrismaService);
    await expect(
      service.reportMessage('user', 'conversation', 'message'),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('not submitted') as unknown,
    });
    expect(upsert).not.toHaveBeenCalled();
  });
  it('refuses manager and external deletion review before changes', async () => {
    const transaction = jest.fn();
    const create = jest.fn();
    const service = new UsersService({
      user: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 'manager', role: 'SALES_MANAGER' }),
      },
      accountDeletionRequest: { create },
      $transaction: transaction,
    } as unknown as PrismaService);
    await expect(
      service.requestAccountDeletion({ id: 'manager' } as AuthenticatedUser),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      service.requestExternalAccountDeletion('person@example.com'),
    ).rejects.toMatchObject({ status: 503 });
    expect(transaction).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it('permits configured preview operations and leaves other environment behavior unchanged', () => {
    process.env.OPERATIONS_WEBHOOK_URL = 'https://operations.example.com/hook';
    expect(() => assertPreviewOperationsConfigured()).not.toThrow();
    delete process.env.OPERATIONS_WEBHOOK_URL;
    process.env.APP_ENV = 'production';
    expect(() => assertPreviewOperationsConfigured()).not.toThrow();
  });
});
