-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('PROSPECT', 'SALES_MANAGER');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'INVITED', 'DISABLED');

-- CreateEnum
CREATE TYPE "CertificationStatus" AS ENUM ('ONBOARDING', 'CLASS_SIGNUP_PENDING', 'IN_PROGRESS', 'CERTIFIED');

-- CreateEnum
CREATE TYPE "InviteStatusRole" AS ENUM ('PROSPECT', 'SALES_MANAGER');

-- CreateEnum
CREATE TYPE "ClassSessionStatus" AS ENUM ('SCHEDULED', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ClassEnrollmentStatus" AS ENUM ('ENROLLED', 'COMPLETED', 'CANCELED');

-- CreateEnum
CREATE TYPE "EquipmentRegistrationStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('CATALOG', 'REGISTRATION_OVERVIEW', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "TodoItemType" AS ENUM ('CLASS_SIGNUP', 'EQUIPMENT_REGISTRATION', 'MARKETING_CONSULTATION', 'JB_WARRANTIES', 'RESOURCE_REVIEW');

-- CreateEnum
CREATE TYPE "TodoItemStatus" AS ENUM ('OPEN', 'COMPLETED');

-- CreateEnum
CREATE TYPE "BenefitType" AS ENUM ('DISCOUNT', 'WARRANTY', 'LEAD_GENERATION');

-- CreateEnum
CREATE TYPE "MarketingSubmissionStatus" AS ENUM ('NOT_SUBMITTED', 'SUBMITTED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "LeadRecordStatus" AS ENUM ('NEW', 'CONTACTED', 'IN_PROGRESS', 'CERTIFIED', 'LOST');

-- CreateEnum
CREATE TYPE "ConversationType" AS ENUM ('PROSPECT_MANAGER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "role" "UserRole" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "signupDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedSalesManagerId" TEXT NOT NULL,
    "certificationStatus" "CertificationStatus" NOT NULL DEFAULT 'ONBOARDING',
    "marketingConsultationDueAt" TIMESTAMP(3) NOT NULL,
    "marketingConsultationCompletedAt" TIMESTAMP(3),
    "jbWarrantiesDueAt" TIMESTAMP(3) NOT NULL,
    "jbWarrantiesCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProspectProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesManagerProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesManagerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegistrationInvite" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "roleToCreate" "InviteStatusRole" NOT NULL DEFAULT 'PROSPECT',
    "assignedSalesManagerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RegistrationInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassSession" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "virtualUrl" TEXT NOT NULL,
    "status" "ClassSessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassEnrollment" (
    "id" TEXT NOT NULL,
    "classSessionId" TEXT NOT NULL,
    "prospectUserId" TEXT NOT NULL,
    "status" "ClassEnrollmentStatus" NOT NULL DEFAULT 'ENROLLED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentRegistration" (
    "id" TEXT NOT NULL,
    "prospectUserId" TEXT NOT NULL,
    "equipmentName" TEXT NOT NULL,
    "modelNumber" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "status" "EquipmentRegistrationStatus" NOT NULL DEFAULT 'SUBMITTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resource" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "resourceType" "ResourceType" NOT NULL,
    "url" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TodoItem" (
    "id" TEXT NOT NULL,
    "prospectUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" "TodoItemType" NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "status" "TodoItemStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TodoItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Benefit" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "benefitType" "BenefitType" NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Benefit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingConsultation" (
    "id" TEXT NOT NULL,
    "prospectUserId" TEXT NOT NULL,
    "availabilityOptionOne" TEXT,
    "availabilityOptionTwo" TEXT,
    "availabilityOptionThree" TEXT,
    "externalSubmissionStatus" "MarketingSubmissionStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingConsultation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadRecord" (
    "id" TEXT NOT NULL,
    "prospectUserId" TEXT NOT NULL,
    "assignedSalesManagerId" TEXT NOT NULL,
    "status" "LeadRecordStatus" NOT NULL DEFAULT 'NEW',
    "notes" TEXT,
    "externalLeadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "type" "ConversationType" NOT NULL DEFAULT 'PROSPECT_MANAGER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastMessageAt" TIMESTAMP(3),

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationParticipant" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ProspectProfile_userId_key" ON "ProspectProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesManagerProfile_userId_key" ON "SalesManagerProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RegistrationInvite_token_key" ON "RegistrationInvite"("token");

-- CreateIndex
CREATE UNIQUE INDEX "ClassSession_virtualUrl_key" ON "ClassSession"("virtualUrl");

-- CreateIndex
CREATE UNIQUE INDEX "ClassEnrollment_classSessionId_prospectUserId_key" ON "ClassEnrollment"("classSessionId", "prospectUserId");

-- CreateIndex
CREATE UNIQUE INDEX "EquipmentRegistration_serialNumber_key" ON "EquipmentRegistration"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Resource_url_key" ON "Resource"("url");

-- CreateIndex
CREATE UNIQUE INDEX "TodoItem_prospectUserId_type_key" ON "TodoItem"("prospectUserId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Benefit_url_key" ON "Benefit"("url");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingConsultation_prospectUserId_key" ON "MarketingConsultation"("prospectUserId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadRecord_prospectUserId_key" ON "LeadRecord"("prospectUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationParticipant_conversationId_userId_key" ON "ConversationParticipant"("conversationId", "userId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_senderId_clientMessageId_key" ON "Message"("senderId", "clientMessageId");

-- AddForeignKey
ALTER TABLE "ProspectProfile" ADD CONSTRAINT "ProspectProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectProfile" ADD CONSTRAINT "ProspectProfile_assignedSalesManagerId_fkey" FOREIGN KEY ("assignedSalesManagerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesManagerProfile" ADD CONSTRAINT "SalesManagerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassEnrollment" ADD CONSTRAINT "ClassEnrollment_classSessionId_fkey" FOREIGN KEY ("classSessionId") REFERENCES "ClassSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassEnrollment" ADD CONSTRAINT "ClassEnrollment_prospectUserId_fkey" FOREIGN KEY ("prospectUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentRegistration" ADD CONSTRAINT "EquipmentRegistration_prospectUserId_fkey" FOREIGN KEY ("prospectUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TodoItem" ADD CONSTRAINT "TodoItem_prospectUserId_fkey" FOREIGN KEY ("prospectUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingConsultation" ADD CONSTRAINT "MarketingConsultation_prospectUserId_fkey" FOREIGN KEY ("prospectUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecord" ADD CONSTRAINT "LeadRecord_prospectUserId_fkey" FOREIGN KEY ("prospectUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadRecord" ADD CONSTRAINT "LeadRecord_assignedSalesManagerId_fkey" FOREIGN KEY ("assignedSalesManagerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationParticipant" ADD CONSTRAINT "ConversationParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
