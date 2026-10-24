import { UserRole, UserStatus } from '@prisma/client';
import { Request } from 'express';

export type AuthenticatedUser = {
  id: string;
  onboardingRequired?: boolean;
  initialTrainingVerifiedAt?: Date | null;
  sessionVersion?: number;
  sessionTokenHash?: string;
  sessionExpiresAt?: number;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
  termsAcceptedAt: Date | null;
  termsVersion: string | null;
};

export type RequestWithUser = Request & {
  user: AuthenticatedUser;
};
