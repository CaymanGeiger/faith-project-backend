import { Prisma } from '@prisma/client';
import { provisionJotformAccount } from './jotform-onboarding';
import { decryptDeliveryCode } from '../auth/security-code';
import { CanonicalJotformSubmission } from '../jotform/jotform-submission.mapper';

describe('Jotform account provisioning', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.JOTFORM_ONBOARDING_ENABLED = 'true';
    process.env.JOTFORM_ONBOARDING_MANAGER_ID = 'manager';
    process.env.JWT_SECRET = 'isolated-test-secret';
  });
  afterEach(() => {
    for (const key of [
      'JOTFORM_ONBOARDING_ENABLED',
      'JOTFORM_ONBOARDING_MANAGER_ID',
      'JWT_SECRET',
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  const canonical = {
    respondentEmail: 'dealer@example.com',
    companyName: 'Example HVAC',
    vendorStatus: 'ACTIVE',
  } as CanonicalJotformSubmission;
  function fixture() {
    const tx = {
      user: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ id: 'manager' }),
        create: jest
          .fn()
          .mockResolvedValue({ id: 'dealer', sessionVersion: 0 }),
      },
      jotformSubmission: { update: jest.fn() },
      accountDeletionRequest: { findFirst: jest.fn().mockResolvedValue(null) },
      conversation: { create: jest.fn() },
      securityChallenge: { create: jest.fn() },
    };
    return {
      tx,
      run: () =>
        provisionJotformAccount(
          tx as unknown as Prisma.TransactionClient,
          'submission',
          canonical,
        ),
    };
  }
  it('persists an invited restricted user and encrypted activation outbox while leaving ownership unverified', async () => {
    const f = fixture();
    await f.run();
    expect(f.tx.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'INVITED',
        onboardingRequired: true,
        activationSubmissionId: 'submission',
      }) as unknown,
    });
    const challenge = (
      f.tx.securityChallenge.create.mock.calls as [
        { data: { deliveryCode: string; codeHash: string; purpose: string } },
      ][]
    )[0][0].data;
    const code = decryptDeliveryCode(
      challenge.deliveryCode,
      'dealer:ACCOUNT_ACTIVATION:dealer@example.com',
    );
    expect(code).toMatch(/^\d{8}$/);
    expect(challenge.codeHash).not.toBe(code);
    expect(challenge.purpose).toBe('ACCOUNT_ACTIVATION');
    expect(f.tx.jotformSubmission.update).not.toHaveBeenCalled();
  });
  it('never modifies existing accounts or sends duplicate activation on repeated source imports', async () => {
    const f = fixture();
    f.tx.user.findUnique.mockResolvedValue({
      id: 'existing',
      email: canonical.respondentEmail,
    });
    await f.run();
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.tx.securityChallenge.create).not.toHaveBeenCalled();
  });
  it('does not claim, overwrite or reactivate an existing email-matched account', async () => {
    const f = fixture();
    f.tx.user.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'existing-account',
      status: 'ACTIVE',
      email: canonical.respondentEmail,
    });
    await f.run();
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.tx.securityChallenge.create).not.toHaveBeenCalled();
    expect(f.tx.jotformSubmission.update).not.toHaveBeenCalled();
  });

  it('propagates transaction failures to the canonical import retry handler', async () => {
    const f = fixture();
    f.tx.user.create.mockRejectedValue(new Error('transaction write failed'));
    await expect(f.run()).rejects.toThrow('transaction write failed');
    expect(f.tx.securityChallenge.create).not.toHaveBeenCalled();
  });

  it('flags changed source identity without creating a second account', async () => {
    const f = fixture();
    f.tx.user.findUnique.mockResolvedValueOnce({
      id: 'dealer',
      email: 'original@example.com',
    });
    await f.run();
    expect(f.tx.jotformSubmission.update).toHaveBeenCalledWith({
      where: { id: 'submission' },
      data: { reviewReasonCode: 'ONBOARDING_IDENTITY_REVIEW' },
    });
    expect(f.tx.user.create).not.toHaveBeenCalled();
  });
  it('queues missing manager configuration for review instead of assigning an arbitrary manager', async () => {
    const f = fixture();
    delete process.env.JOTFORM_ONBOARDING_MANAGER_ID;
    await f.run();
    expect(f.tx.user.findFirst).not.toHaveBeenCalled();
    expect(f.tx.user.create).not.toHaveBeenCalled();
    expect(f.tx.jotformSubmission.update).toHaveBeenCalledWith({
      where: { id: 'submission' },
      data: { reviewReasonCode: 'ONBOARDING_MANAGER_REQUIRED' },
    });
  });
  it('preserves deletion review and does not create a disabled replacement', async () => {
    const f = fixture();
    f.tx.accountDeletionRequest.findFirst.mockResolvedValue({ id: 'deletion' });
    await f.run();
    expect(f.tx.user.create).not.toHaveBeenCalled();
  });
});
