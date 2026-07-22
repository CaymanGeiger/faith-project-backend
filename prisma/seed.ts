import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

async function main() {
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
    },
    create: {
      email: 'manager@hercules.local',
      passwordHash,
      firstName: 'Avery',
      lastName: 'Cole',
      phone: '555-0100',
      role: UserRole.SALES_MANAGER,
      status: UserStatus.ACTIVE,
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
    },
    create: {
      email: 'prospect@hercules.local',
      passwordHash,
      firstName: 'Mike',
      lastName: 'Johnson',
      phone: '555-0111',
      role: UserRole.PROSPECT,
      status: UserStatus.ACTIVE,
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

  await prisma.registrationInvite.upsert({
    where: { token: 'prospect-demo-token' },
    update: {
      assignedSalesManagerId: manager.id,
      expiresAt: addDays(now, 30),
      usedAt: null,
    },
    create: {
      token: 'prospect-demo-token',
      assignedSalesManagerId: manager.id,
      expiresAt: addDays(now, 30),
    },
  });

  await prisma.classSession.createMany({
    data: [
      {
        title: 'LG Dealer Certification: Foundations',
        description: 'Virtual certification session for new LG Pro Dealers.',
        startsAt: addDays(now, 7),
        endsAt: addDays(now, 7),
        virtualUrl: 'https://example.com/lg-foundations',
      },
      {
        title: 'LG Equipment Registration Workshop',
        description: 'Virtual training for registration and warranty workflows.',
        startsAt: addDays(now, 21),
        endsAt: addDays(now, 21),
        virtualUrl: 'https://example.com/lg-registration',
      },
    ],
    skipDuplicates: true,
  });

  await prisma.resource.createMany({
    data: [
      {
        title: 'LG Catalog Overview',
        description: 'Catalog placeholder for LG equipment resources.',
        resourceType: 'CATALOG',
        category: 'LG Catalogs',
        url: 'https://example.com/lg-catalog-overview',
      },
      {
        title: 'Registration Overview',
        description: 'Overview page for equipment registration steps.',
        resourceType: 'REGISTRATION_OVERVIEW',
        category: 'Registration',
        url: 'https://example.com/registration-overview',
      },
      {
        title: 'LG ThinQ',
        description: 'LG app resource for connected equipment and product support.',
        resourceType: 'APP',
        category: 'LG Apps',
        url: 'https://apps.apple.com/us/search?term=LG%20ThinQ',
      },
      {
        title: 'LG HVAC Service',
        description: 'LG app resource for HVAC service support.',
        resourceType: 'APP',
        category: 'LG Apps',
        url: 'https://apps.apple.com/us/search?term=LG%20HVAC%20Service',
      },
      {
        title: 'LGMV-Business',
        description: 'LG app resource for business HVAC service tools.',
        resourceType: 'APP',
        category: 'LG Apps',
        url: 'https://apps.apple.com/us/search?term=LGMV-Business',
      },
    ],
    skipDuplicates: true,
  });

  await prisma.benefit.createMany({
    data: [
      {
        title: 'Dealer Discounts',
        description: 'Discount benefit information for LG Pro Dealers.',
        benefitType: 'DISCOUNT',
        url: 'https://example.com/dealer-discounts',
      },
      {
        title: 'Warranty Support',
        description: 'Warranty support benefit details.',
        benefitType: 'WARRANTY',
        url: 'https://example.com/warranty-support',
      },
      {
        title: 'Lead Generation',
        description: 'Lead generation benefit overview.',
        benefitType: 'LEAD_GENERATION',
        url: 'https://example.com/lead-generation',
      },
    ],
    skipDuplicates: true,
  });

  await prisma.todoItem.createMany({
    data: [
      {
        prospectUserId: prospect.id,
        title: 'Sign up for certification classes',
        description: 'Use the Hercules event calendar to choose a class.',
        type: 'CLASS_SIGNUP',
        dueAt: addDays(now, 14),
      },
      {
        prospectUserId: prospect.id,
        title: 'Register your equipment',
        description: 'Add your first LG equipment registration.',
        type: 'EQUIPMENT_REGISTRATION',
        dueAt: addDays(now, 14),
      },
      {
        prospectUserId: prospect.id,
        title: 'Sign up with JB Warranties',
        description: 'Required within 30 days after signing up.',
        type: 'JB_WARRANTIES',
        dueAt: addDays(now, 30),
      },
      {
        prospectUserId: prospect.id,
        title: 'Schedule a marketing consultation',
        description: 'Complete the marketing consultation form.',
        type: 'MARKETING_CONSULTATION',
        dueAt: addDays(now, 90),
      },
    ],
    skipDuplicates: true,
  });

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
