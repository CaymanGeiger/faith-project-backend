import { PrismaService } from '../prisma/prisma.service';
import {
  DevelopmentTrainingService,
  isLocalDevelopmentDatabase,
} from './development-training.service';

describe('Development-only initial training toggle', () => {
  const keys = [
    'NODE_ENV',
    'APP_ENV',
    'DATABASE_URL',
    'DEV_FEATURES_ENABLED',
    'DEV_TRAINING_TOGGLE_ENABLED',
  ];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.APP_ENV;
    process.env.DATABASE_URL =
      'postgresql://localhost:55439/hercules_release_test';
    process.env.DEV_TRAINING_TOGGLE_ENABLED = 'true';
    process.env.DEV_FEATURES_ENABLED = 'true';
  });
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  function fixture() {
    const user = {
      id: 'dealer',
      email: 'prospect@hercules.local',
      role: 'PROSPECT',
      status: 'ACTIVE',
      onboardingRequired: true,
      initialTrainingVerifiedAt: null as Date | null,
      initialTrainingVerification: null as unknown,
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        update: jest
          .fn()
          .mockImplementation(
            ({
              data,
            }: {
              data: { initialTrainingVerifiedAt: Date | null };
            }) => {
              Object.assign(user, data);
              return Promise.resolve({ ...user });
            },
          ),
      },
      initialTrainingVerification: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: Record<string, unknown> }) => {
            user.initialTrainingVerification = {
              ...data,
              id: 'dev-evidence',
              enrollmentId: null,
            };
            return Promise.resolve(user.initialTrainingVerification);
          }),
        delete: jest.fn().mockImplementation(() => {
          user.initialTrainingVerification = null;
          return Promise.resolve({});
        }),
      },
    };
    const transaction = jest.fn((fn: (value: typeof tx) => unknown) => fn(tx));
    return {
      user,
      tx,
      transaction,
      service: new DevelopmentTrainingService({
        ...tx,
        $transaction: transaction,
      } as unknown as PrismaService),
    };
  }
  it.each(['production', 'staging', undefined])(
    'rejects runtime %s even with the flag enabled',
    async (runtime) => {
      if (runtime === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = runtime;
      const f = fixture();
      await expect(f.service.setTraining('dealer', true)).rejects.toMatchObject(
        { status: 404 },
      );
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );
  it('allows synthetic preview training on a remote database while NODE_ENV remains production', async () => {
    process.env.APP_ENV = 'preview';
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://preview.example.com/app';
    const f = fixture();
    await expect(f.service.setTraining('dealer', true)).resolves.toMatchObject({
      access: { restricted: false },
      development: true,
    });
    await expect(f.service.setTraining('dealer', false)).resolves.toMatchObject(
      {
        access: { restricted: true },
      },
    );
  });
  it.each([
    'dealer@example.com',
    'dealer@herculesindustries.com',
    'dealer@hercules.local.example.com',
  ])(
    'forbids preview training writes for a real account: %s',
    async (email) => {
      process.env.APP_ENV = 'preview';
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://preview.example.com/app';
      const f = fixture();
      f.user.email = email;
      await expect(f.service.setTraining('dealer', true)).rejects.toMatchObject(
        { status: 404 },
      );
      await expect(
        f.service.setTraining('dealer', false),
      ).rejects.toMatchObject({ status: 404 });
      expect(f.tx.user.update).not.toHaveBeenCalled();
      expect(f.tx.initialTrainingVerification.create).not.toHaveBeenCalled();
      expect(f.tx.initialTrainingVerification.delete).not.toHaveBeenCalled();
    },
  );
  it.each(['production', 'staging', 'development', undefined])(
    'blocks training on a remote database when APP_ENV is %s',
    async (deployment) => {
      if (deployment === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = deployment;
      process.env.NODE_ENV = 'production';
      process.env.DATABASE_URL = 'postgresql://preview.example.com/app';
      const f = fixture();
      await expect(f.service.setTraining('dealer', true)).rejects.toMatchObject(
        { status: 404 },
      );
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['false', '', 'TRUE'])(
    'requires the exact opt-in flag: %s',
    async (value) => {
      process.env.DEV_TRAINING_TOGGLE_ENABLED = value;
      const f = fixture();
      await expect(f.service.setTraining('dealer', true)).rejects.toMatchObject(
        { status: 404 },
      );
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['false', '', 'TRUE', undefined])(
    'requires the development master opt-in: %s',
    async (value) => {
      if (value === undefined) delete process.env.DEV_FEATURES_ENABLED;
      else process.env.DEV_FEATURES_ENABLED = value;
      const f = fixture();
      await expect(f.service.setTraining('dealer', true)).rejects.toMatchObject(
        { status: 404 },
      );
      expect(f.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    'bad-url',
    'https://localhost/app_test',
    'postgresql://db.example.com/app_test',
    'postgresql://localhost/production',
    'postgresql://127.0.0.1/app_test?host=db.example.com',
  ])('rejects unsafe database configuration %s', async (database) => {
    expect(isLocalDevelopmentDatabase(database)).toBe(false);
    if (database === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = database;
    const f = fixture();
    await expect(f.service.setTraining('dealer', false)).rejects.toMatchObject({
      status: 404,
    });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it.each([
    'postgresql://127.0.0.1/hercules_test',
    'postgres://localhost/hercules_dev',
    'postgresql://[::1]/hercules_test',
  ])('accepts explicitly local development database %s', (database) =>
    expect(isLocalDevelopmentDatabase(database)).toBe(true),
  );
  it.each(['ACTIVE_MANAGER', 'INVITED', 'DISABLED'])(
    'does not mutate an unauthorized identity %s',
    async (value) => {
      const f = fixture();
      if (value === 'ACTIVE_MANAGER') f.user.role = 'SALES_MANAGER';
      else f.user.status = value;
      await expect(f.service.setTraining('dealer', true)).rejects.toMatchObject(
        { status: 404 },
      );
      expect(f.tx.user.update).not.toHaveBeenCalled();
    },
  );
  it('toggles only marked development evidence idempotently and changes access in both directions', async () => {
    const f = fixture();
    expect(await f.service.setTraining('dealer', true)).toMatchObject({
      access: { restricted: false },
      development: true,
    });
    expect(f.tx.initialTrainingVerification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        developmentOnly: true,
        verifiedByUserId: null,
        source: 'DEVELOPMENT_TRAINING_TOGGLE',
        prospectUserId: 'dealer',
      }) as unknown,
    });
    await f.service.setTraining('dealer', true);
    expect(f.tx.initialTrainingVerification.create).toHaveBeenCalledTimes(1);
    expect(await f.service.setTraining('dealer', false)).toMatchObject({
      access: { restricted: true },
      development: true,
    });
    await f.service.setTraining('dealer', false);
    expect(f.tx.initialTrainingVerification.delete).toHaveBeenCalledTimes(1);
  });
  it.each(['genuine', 'forged-source', 'orphan-timestamp'])(
    'preserves %s evidence',
    async (value) => {
      const f = fixture();
      f.user.initialTrainingVerifiedAt = new Date();
      if (value !== 'orphan-timestamp')
        f.user.initialTrainingVerification = {
          id: 'real',
          developmentOnly: false,
          verifiedByUserId: value === 'genuine' ? 'manager' : null,
          source: 'DEVELOPMENT_TRAINING_TOGGLE',
          reference: 'development-toggle:dealer',
          enrollmentId: null,
        };
      await expect(
        f.service.setTraining('dealer', false),
      ).rejects.toMatchObject({ status: 409 });
      await expect(f.service.setTraining('dealer', true)).rejects.toMatchObject(
        { status: 409 },
      );
      expect(f.tx.user.update).not.toHaveBeenCalled();
      expect(f.tx.initialTrainingVerification.delete).not.toHaveBeenCalled();
    },
  );
  it('preserves existing-account policy rather than converting a legacy dealer', async () => {
    const f = fixture();
    f.user.onboardingRequired = false;
    await expect(f.service.setTraining('dealer', false)).rejects.toMatchObject({
      status: 409,
    });
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
});
