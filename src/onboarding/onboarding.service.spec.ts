import { PrismaService } from '../prisma/prisma.service';
import { onboardingAccess } from './onboarding-access';
import { OnboardingService } from './onboarding.service';

describe('Verified initial training access', () => {
  const original = process.env.ONBOARDING_VERIFIER_MANAGER_IDS;
  afterEach(() => {
    if (original === undefined)
      delete process.env.ONBOARDING_VERIFIER_MANAGER_IDS;
    else process.env.ONBOARDING_VERIFIER_MANAGER_IDS = original;
  });
  const dto = {
    completedAt: '2026-01-01T12:00:00.000Z',
    source: 'Approved attendance roster',
    reference: 'record-123',
  };
  function fixture() {
    process.env.ONBOARDING_VERIFIER_MANAGER_IDS = 'manager';
    const user = {
      id: 'dealer',
      role: 'PROSPECT',
      status: 'ACTIVE',
      onboardingRequired: true,
      initialTrainingVerifiedAt: null as Date | null,
      initialTrainingVerification: null as unknown,
      prospectProfile: { assignedSalesManagerId: 'manager' },
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      user: {
        findUnique: jest.fn().mockResolvedValue(user),
        update: jest
          .fn()
          .mockImplementation(
            ({ data }: { data: { initialTrainingVerifiedAt: Date } }) =>
              Promise.resolve({ ...user, ...data }),
          ),
      },
      classEnrollment: { findUnique: jest.fn(), update: jest.fn() },
      initialTrainingVerification: {
        create: jest
          .fn()
          .mockImplementation(({ data }: { data: unknown }) =>
            Promise.resolve(data),
          ),
      },
    };
    return {
      user,
      tx,
      service: new OnboardingService({
        ...tx,
        $transaction: (fn: (input: typeof tx) => unknown) => fn(tx),
      } as unknown as PrismaService),
    };
  }
  it('keeps new prospects restricted through registration, enrollment and unverified certification', () => {
    expect(
      onboardingAccess({ role: 'PROSPECT', onboardingRequired: true }, true),
    ).toMatchObject({
      restricted: true,
      nextAction: 'WAIT_FOR_VERIFICATION',
      trainingVerifiedAt: null,
    });
    expect(
      onboardingAccess({ role: 'PROSPECT', onboardingRequired: false }),
    ).toMatchObject({ state: 'EXISTING_ACCESS', trainingVerifiedAt: null });
    expect(onboardingAccess({ role: 'SALES_MANAGER' }).restricted).toBe(false);
  });
  it('fails closed when no approved verification owner is configured', async () => {
    const f = fixture();
    delete process.env.ONBOARDING_VERIFIER_MANAGER_IDS;
    await expect(
      f.service.verifyInitialTraining('manager', 'dealer', dto),
    ).rejects.toThrow('not enabled');
    expect(f.tx.user.findUnique).not.toHaveBeenCalled();
  });
  it('preserves manager ownership scope', async () => {
    const f = fixture();
    f.user.prospectProfile.assignedSalesManagerId = 'other';
    await expect(
      f.service.verifyInitialTraining('manager', 'dealer', dto),
    ).rejects.toThrow('not assigned');
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it.each(['INVITED', 'DISABLED'])(
    'does not unlock %s accounts',
    async (status) => {
      const f = fixture();
      f.user.status = status;
      await expect(
        f.service.verifyInitialTraining('manager', 'dealer', dto),
      ).rejects.toThrow('Activate');
      expect(f.tx.initialTrainingVerification.create).not.toHaveBeenCalled();
    },
  );
  it('rejects future completion and enrollment owned by another dealer', async () => {
    const f = fixture();
    await expect(
      f.service.verifyInitialTraining('manager', 'dealer', {
        ...dto,
        completedAt: '2099-01-01T12:00:00Z',
      }),
    ).rejects.toThrow('past');
    f.tx.classEnrollment.findUnique.mockResolvedValue({
      prospectUserId: 'other',
    });
    await expect(
      f.service.verifyInitialTraining('manager', 'dealer', {
        ...dto,
        enrollmentId: 'wrong',
      }),
    ).rejects.toThrow('belonging');
    expect(f.tx.user.update).not.toHaveBeenCalled();
  });
  it('atomically audits trusted evidence and unlocks initial training without issuing certification', async () => {
    const f = fixture();
    expect(
      await f.service.verifyInitialTraining('manager', 'dealer', dto),
    ).toMatchObject({
      access: { restricted: false, state: 'TRAINING_VERIFIED' },
      verification: {
        source: dto.source,
        reference: dto.reference,
        verifiedByUserId: 'manager',
        prospectUserId: 'dealer',
      },
    });
    expect(f.tx.user.update).toHaveBeenCalledWith({
      where: { id: 'dealer' },
      data: { initialTrainingVerifiedAt: expect.any(Date) as unknown },
    });
  });
  it('requires removal of a mock before genuine manager verification', async () => {
    const f = fixture();
    f.user.initialTrainingVerification = { developmentOnly: true };
    await expect(
      f.service.verifyInitialTraining('manager', 'dealer', dto),
    ).rejects.toThrow('Turn off development training');
    expect(f.tx.user.update).not.toHaveBeenCalled();
    expect(f.tx.initialTrainingVerification.create).not.toHaveBeenCalled();
  });

  it('accepts exact retries but never overwrites audit evidence', async () => {
    const f = fixture();
    f.user.initialTrainingVerifiedAt = new Date();
    f.user.initialTrainingVerification = {
      ...dto,
      completedAt: new Date(dto.completedAt),
      enrollmentId: null,
    };
    await expect(
      f.service.verifyInitialTraining('manager', 'dealer', dto),
    ).resolves.toMatchObject({ access: { restricted: false } });
    await expect(
      f.service.verifyInitialTraining('manager', 'dealer', {
        ...dto,
        reference: 'different',
      }),
    ).rejects.toThrow('already verified');
    expect(f.tx.initialTrainingVerification.create).not.toHaveBeenCalled();
  });
});
