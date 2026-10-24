import { createHash } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  BEFORE_TRAINING_KEY,
  onboardingAccess,
} from '../onboarding/onboarding-access';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { AuthenticatedUser } from './authenticated-user';
import { isAccountAllowedInRuntime } from '../config/development';

type JwtPayload = {
  sub: string;
  sv?: number;
  exp?: number;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector = new Reflector(),
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.getBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid bearer token');
    }

    const sessionTokenHash = createHash('sha256').update(token).digest('hex');
    if (
      await this.prisma.revokedSession.findUnique({
        where: { tokenHash: sessionTokenHash },
      })
    )
      throw new UnauthorizedException('Please sign in again');
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        sessionVersion: true,
        onboardingRequired: true,
        initialTrainingVerifiedAt: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
        role: true,
        status: true,
        termsAcceptedAt: true,
        termsVersion: true,
      },
    });

    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      !isAccountAllowedInRuntime(user.email)
    ) {
      throw new UnauthorizedException('User is not active');
    }

    if ((payload.sv ?? 0) !== (user.sessionVersion ?? 0)) {
      throw new UnauthorizedException('Please sign in again');
    }
    if (
      onboardingAccess(user).restricted &&
      !this.reflector.getAllAndOverride<boolean>(BEFORE_TRAINING_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      throw new ForbiddenException({
        code: 'INITIAL_TRAINING_REQUIRED',
        message:
          'Complete initial training and have Hercules verify it to unlock this feature.',
      });
    }
    (request as Request & { user: AuthenticatedUser }).user = {
      ...user,
      sessionExpiresAt: payload.exp,
      sessionTokenHash,
    };
    return true;
  }

  private getBearerToken(request: Request) {
    const header = request.headers.authorization;
    const [type, token] = header?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
