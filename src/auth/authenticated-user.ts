import { UserRole, UserStatus } from '@prisma/client';
import { Request } from 'express';

export type AuthenticatedUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  role: UserRole;
  status: UserStatus;
};

export type RequestWithUser = Request & {
  user: AuthenticatedUser;
};
