import {
  InviteStatusRole,
  PrismaClient,
  TodoItemType,
  UserRole,
  UserStatus,
} from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { CURRENT_TERMS_VERSION } from '../src/legal/legal.constants';
import { isDevelopmentSeedEnabled } from '../src/config/development';
import { hashInviteToken } from '../src/auth/invite-token';

const prisma = new PrismaClient();

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const prospectDemoToken = 'prospect-demo-token';
const managerDemoToken = 'manager-demo-token';

async function main() {
  if (!isDevelopmentSeedEnabled()) {
    throw new Error(
      'Refusing to seed demo data. Require NODE_ENV=development/test, DEV_FEATURES_ENABLED=true, ALLOW_DEMO_SEED=true and a loopback PostgreSQL database named *_dev, *_test or faith_project.',
    );
  }

  const passwordHash = await bcrypt.hash('password123', 12);
  const now = new Date();

  const manager = await prisma.user.upsert({
    where: { email: 'manager@hercules.local' },
    update: {
      passwordHash,
      firstName: 'Avery',
      lastName: 'Cole',
      role: UserRole.SALES_MANAGER,
      status: UserStatus.ACTIVE,
      termsAcceptedAt: now,
      termsVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedAt: now,
    },
    create: {
      email: 'manager@hercules.local',
      passwordHash,
      firstName: 'Avery',
      lastName: 'Cole',
      phone: '555-0100',
      role: UserRole.SALES_MANAGER,
      status: UserStatus.ACTIVE,
      termsAcceptedAt: now,
      termsVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedAt: now,
      salesManagerProfile: { create: {} },
    },
  });

  await prisma.salesManagerProfile.upsert({
    where: { userId: manager.id },
    update: {},
    create: { userId: manager.id },
  });

  const prospect = await prisma.user.upsert({
    where: { email: 'prospect@hercules.local' },
    update: {
      passwordHash,
      firstName: 'Mike',
      lastName: 'Johnson',
      phone: '555-0111',
      role: UserRole.PROSPECT,
      status: UserStatus.ACTIVE,
      termsAcceptedAt: now,
      termsVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedAt: now,
    },
    create: {
      email: 'prospect@hercules.local',
      passwordHash,
      firstName: 'Mike',
      lastName: 'Johnson',
      phone: '555-0111',
      role: UserRole.PROSPECT,
      status: UserStatus.ACTIVE,
      termsAcceptedAt: now,
      termsVersion: CURRENT_TERMS_VERSION,
      privacyPolicyAcceptedAt: now,
    },
  });

  await prisma.prospectProfile.upsert({
    where: { userId: prospect.id },
    update: {
      companyName: 'Johnson Comfort HVAC',
      assignedSalesManagerId: manager.id,
    },
    create: {
      userId: prospect.id,
      companyName: 'Johnson Comfort HVAC',
      signupDate: now,
      assignedSalesManagerId: manager.id,
      marketingConsultationDueAt: addDays(now, 90),
      jbWarrantiesDueAt: addDays(now, 30),
    },
  });

  await prisma.registrationInvite.deleteMany({
    where: { token: { in: [prospectDemoToken, managerDemoToken] } },
  });

  await prisma.registrationInvite.upsert({
    where: { token: hashInviteToken(prospectDemoToken) },
    update: {
      assignedSalesManagerId: manager.id,
      recipientEmail: 'new-prospect@hercules.local',
      expiresAt: addDays(now, 30),
      usedAt: null,
    },
    create: {
      token: hashInviteToken(prospectDemoToken),
      assignedSalesManagerId: manager.id,
      recipientEmail: 'new-prospect@hercules.local',
      expiresAt: addDays(now, 30),
    },
  });

  await prisma.registrationInvite.upsert({
    where: { token: hashInviteToken(managerDemoToken) },
    update: {
      roleToCreate: InviteStatusRole.SALES_MANAGER,
      assignedSalesManagerId: manager.id,
      recipientEmail: 'new-manager@hercules.local',
      expiresAt: addDays(now, 30),
      usedAt: null,
    },
    create: {
      token: hashInviteToken(managerDemoToken),
      roleToCreate: InviteStatusRole.SALES_MANAGER,
      assignedSalesManagerId: manager.id,
      recipientEmail: 'new-manager@hercules.local',
      expiresAt: addDays(now, 30),
    },
  });

  await prisma.$transaction([
    prisma.classSession.deleteMany({
      where: {
        virtualUrl: {
          in: [
            'https://example.com/lg-foundations',
            'https://example.com/lg-registration',
          ],
        },
      },
    }),
    prisma.resource.deleteMany({
      where: {
        url: {
          in: [
            'https://example.com/lg-catalog-overview',
            'https://example.com/registration-overview',
            'https://apps.apple.com/us/search?term=LG%20ThinQ',
            'https://apps.apple.com/us/search?term=LG%20HVAC%20Service',
            'https://apps.apple.com/us/search?term=LGMV-Business',
          ],
        },
      },
    }),
    prisma.benefit.deleteMany({
      where: {
        url: {
          in: [
            'https://example.com/dealer-discounts',
            'https://example.com/warranty-support',
            'https://example.com/lead-generation',
          ],
        },
      },
    }),
  ]);

  const classSessions = [
    {
      title: 'LG Dealer Certification: Foundations',
      description:
        'Save your training preference here. Hercules will confirm final enrollment and class logistics.',
      startsAt: addDays(now, 7),
      endsAt: addDays(now, 7),
      virtualUrl: 'https://lghvac.com/training',
    },
    {
      title: 'LG Equipment Registration Workshop',
      description:
        'Save your workshop preference here. Hercules will confirm availability and registration details.',
      startsAt: addDays(now, 21),
      endsAt: addDays(now, 21),
      virtualUrl: 'https://www.herculesindustries.com/eventcalendar',
    },
  ];
  await prisma.$transaction(
    classSessions.map((session) =>
      prisma.classSession.upsert({
        where: { virtualUrl: session.virtualUrl },
        update: session,
        create: session,
      }),
    ),
  );

  const resources = [
    {
      title: 'LG Pro Dealer Program',
      description:
        'Review current LG Pro Dealer program information, benefits, and eligibility details.',
      resourceType: 'CATALOG' as const,
      category: 'LG Pro Dealer',
      url: 'https://lghvac.com/residential-light-commercial/lg-pro-dealer-program/',
    },
    {
      title: 'LG Warranty & Registration',
      description:
        'Review LG registration and warranty requirements for eligible equipment.',
      resourceType: 'REGISTRATION_OVERVIEW' as const,
      category: 'Registration',
      url: 'https://lghvac.com/warranty-page/',
    },
    {
      title: 'LG ThinQ',
      description:
        'Review LG ThinQ information and download options for supported connected products.',
      resourceType: 'APP' as const,
      category: 'LG Apps',
      url: 'https://www.lg.com/us/lg-thinq',
    },
    {
      title: 'LG HVAC Training',
      description:
        'Explore current LG HVAC training options for contractors and technicians.',
      resourceType: 'DOCUMENT' as const,
      category: 'Training',
      url: 'https://lghvac.com/training',
    },
    {
      title: 'LG HVAC Resource Library',
      description:
        'Browse LG HVAC technical resources, product literature, and service tools.',
      resourceType: 'DOCUMENT' as const,
      category: 'LG Resources',
      url: 'https://lghvac.com/resources/',
    },
  ];
  await prisma.$transaction(
    resources.map((resource) =>
      prisma.resource.upsert({
        where: { url: resource.url },
        update: resource,
        create: resource,
      }),
    ),
  );

  const benefits = [
    {
      title: 'LG Pro Dealer Benefits',
      description:
        'Review current LG Pro Dealer benefits, tiers, and eligibility requirements.',
      benefitType: 'DISCOUNT' as const,
      url: 'https://lghvac.com/residential-light-commercial/lg-pro-dealer-program/',
    },
    {
      title: 'LG Warranty & Registration Support',
      description:
        'Review warranty and registration requirements for eligible LG HVAC products.',
      benefitType: 'WARRANTY' as const,
      url: 'https://lghvac.com/warranty-page/',
    },
    {
      title: 'LG HVAC Resources & Marketing Support',
      description:
        'Review current LG HVAC resources, then contact Hercules about available marketing and lead support.',
      benefitType: 'LEAD_GENERATION' as const,
      url: 'https://lghvac.com/resources/',
    },
  ];
  await prisma.$transaction(
    benefits.map((benefit) =>
      prisma.benefit.upsert({
        where: { url: benefit.url },
        update: benefit,
        create: benefit,
      }),
    ),
  );

  const seededTodos = [
    {
      title: 'Choose Your LG Training',
      description:
        'Save your preferred LG training session so Hercules can confirm the final schedule and enrollment.',
      type: TodoItemType.CLASS_SIGNUP,
      dueAt: addDays(now, 14),
    },
    {
      title: 'Add Your First LG System',
      description:
        'Save your first equipment record in Hercules Honors Rewards for dealer onboarding.',
      type: TodoItemType.EQUIPMENT_REGISTRATION,
      dueAt: addDays(now, 14),
    },
    {
      title: 'Record Your JB Warranties Setup',
      description:
        'After completing JB Warranties setup, record that completion for your Hercules onboarding.',
      type: TodoItemType.JB_WARRANTIES,
      dueAt: addDays(now, 30),
    },
    {
      title: 'Share Marketing Availability',
      description:
        'Share three times that work for you so Hercules can connect you with marketing resources.',
      type: TodoItemType.MARKETING_CONSULTATION,
      dueAt: addDays(now, 90),
    },
  ];

  await prisma.$transaction(
    seededTodos.map(({ title, description, type, dueAt }) =>
      prisma.todoItem.upsert({
        where: {
          prospectUserId_type: {
            prospectUserId: prospect.id,
            type,
          },
        },
        update: { title, description },
        create: {
          prospectUserId: prospect.id,
          title,
          description,
          type,
          dueAt,
        },
      }),
    ),
  );

  await prisma.equipmentRegistration.createMany({
    data: [
      {
        prospectUserId: prospect.id,
        equipmentName: 'LG Heat Pump',
        modelNumber: 'LG-HP-2400',
        serialNumber: 'LGDEMO-1001',
        status: 'SUBMITTED',
      },
    ],
    skipDuplicates: true,
  });

  await prisma.marketingConsultation.upsert({
    where: { prospectUserId: prospect.id },
    update: {},
    create: { prospectUserId: prospect.id },
  });

  await prisma.leadRecord.upsert({
    where: { prospectUserId: prospect.id },
    update: {
      assignedSalesManagerId: manager.id,
      status: 'CONTACTED',
      notes: 'Initial onboarding conversation started.',
    },
    create: {
      prospectUserId: prospect.id,
      assignedSalesManagerId: manager.id,
      status: 'CONTACTED',
      notes: 'Initial onboarding conversation started.',
    },
  });

  let conversation = await prisma.conversation.findFirst({
    where: {
      participants: {
        every: { userId: { in: [manager.id, prospect.id] } },
      },
    },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        participants: {
          createMany: {
            data: [{ userId: manager.id }, { userId: prospect.id }],
          },
        },
      },
    });
  }

  await prisma.message.upsert({
    where: {
      senderId_clientMessageId: {
        senderId: manager.id,
        clientMessageId: 'seed-manager-welcome',
      },
    },
    update: {},
    create: {
      conversationId: conversation.id,
      senderId: manager.id,
      clientMessageId: 'seed-manager-welcome',
      body: 'Welcome to the Hercules Honors onboarding path. I can help with classes, registration, and resources.',
    },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
