import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { MessagingGateway } from './messaging.gateway';
import { MessagingService } from './messaging.service';

describe('Development account socket enforcement', () => {
  const savedRuntime = process.env.NODE_ENV;
  const savedDeployment = process.env.APP_ENV;
  const savedFlag = process.env.DEV_FEATURES_ENABLED;
  afterEach(() => {
    if (savedRuntime === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedRuntime;
    if (savedDeployment === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = savedDeployment;
    if (savedFlag === undefined) delete process.env.DEV_FEATURES_ENABLED;
    else process.env.DEV_FEATURES_ENABLED = savedFlag;
  });

  it.each([
    ['production', 'true', 'manager@hercules.local', false],
    ['test', 'false', 'manager@hercules.local', false],
    ['test', 'true', 'manager@hercules.local', true],
    ['production', 'false', 'manager@example.com', true],
  ] as const)(
    'runtime %s, flag %s, account %s: allowed=%s',
    async (runtime, flag, email, allowed) => {
      process.env.NODE_ENV = runtime;
      delete process.env.APP_ENV;
      process.env.DEV_FEATURES_ENABLED = flag;
      const gateway = new MessagingGateway(
        {
          verifyAsync: jest.fn().mockResolvedValue({ sub: 'manager' }),
        } as unknown as JwtService,
        {
          revokedSession: { findUnique: jest.fn().mockResolvedValue(null) },
          user: {
            findUnique: jest
              .fn()
              .mockResolvedValue({ id: 'manager', email, status: 'ACTIVE' }),
          },
        } as unknown as PrismaService,
        {} as MessagingService,
      );
      const client = {
        id: 'socket',
        connected: true,
        handshake: { auth: { token: 'session' }, headers: {} },
        data: {},
        emit: jest.fn(),
        disconnect: jest.fn(),
        join: jest.fn().mockResolvedValue(undefined),
      };
      const socket = client as unknown as Parameters<
        MessagingGateway['handleConnection']
      >[0];
      await gateway.handleConnection(socket);
      if (allowed) {
        expect(client.join).toHaveBeenCalledWith('user:manager');
        expect(client.disconnect).not.toHaveBeenCalled();
      } else {
        expect(client.join).not.toHaveBeenCalled();
        expect(client.disconnect).toHaveBeenCalledWith(true);
      }
      gateway.handleDisconnect(socket);
    },
  );
});
