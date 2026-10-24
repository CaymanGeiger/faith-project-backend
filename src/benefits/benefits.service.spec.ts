import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { BenefitsService } from './benefits.service';

describe('Synchrony financing information', () => {
  // Synthetic destinations verify behavior without asserting any approved
  // production Synchrony destination or terms.
  const url = 'https://finance.example.com/program?partner=fixture';
  const description = 'Synthetic program copy supplied by the test owner.';
  const service = (values: Record<string, string | undefined> = {}) =>
    new BenefitsService({} as PrismaService, new ConfigService(values));

  it.each([
    {},
    { SYNCHRONY_FINANCING_URL: url },
    { SYNCHRONY_FINANCING_DESCRIPTION: description },
    {
      SYNCHRONY_FINANCING_URL: url,
      SYNCHRONY_FINANCING_DESCRIPTION: '   ',
    },
  ])('does not publish partial configuration: %p', (config) => {
    expect(service(config).financing()).toEqual({
      financing: {
        title: 'Synchrony Financing',
        available: false,
        description: null,
        url: null,
      },
    });
  });

  it.each([
    'not a link',
    'http://finance.example.com',
    'javascript:alert(1)',
    'https://name:secret@finance.example.com',
    'https://localhost',
    'https://service.internal',
    'https://finance.invalid',
    'https://127.0.0.1',
    'https://[::1]',
    'https://finance.example.com:3000',
  ])('does not expose destinations the in-app viewer rejects: %s', (value) => {
    expect(
      service({
        SYNCHRONY_FINANCING_URL: value,
        SYNCHRONY_FINANCING_DESCRIPTION: description,
      }).financing().financing,
    ).toMatchObject({ available: false, description: null, url: null });
  });

  it('publishes the supplied destination and copy without adding rates or terms', () => {
    expect(
      service({
        SYNCHRONY_FINANCING_URL: `  ${url}  `,
        SYNCHRONY_FINANCING_DESCRIPTION: ` ${description}\nSecond paragraph. `,
      }).financing(),
    ).toEqual({
      financing: {
        title: 'Synchrony Financing',
        available: true,
        description: `${description}\nSecond paragraph.`,
        url,
      },
    });
  });

  it('preserves existing benefit ordering and unavailable-link filtering', async () => {
    const existing = {
      id: 'benefit',
      url: 'https://benefits.example.com/program',
    };
    const prisma = {
      benefit: {
        findMany: jest
          .fn()
          .mockResolvedValue([existing, { id: 'draft', url: '' }]),
      },
    };
    const benefits = new BenefitsService(
      prisma as unknown as PrismaService,
      new ConfigService(),
    );
    await expect(benefits.list()).resolves.toEqual({ benefits: [existing] });
    expect(prisma.benefit.findMany).toHaveBeenCalledWith({
      orderBy: { title: 'asc' },
    });
  });
});
