import { AccountSecurityController } from './account-security.controller';
import { AccountSecurityService } from './account-security.service';
import { SecurityMailService } from './security-mail.service';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { isProductionLikeRuntime } from '../config/runtime';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const configuredExpiry = config.get<string>('JWT_EXPIRES_IN');
        const configuredSecret = config.get<string>('JWT_SECRET');
        if (
          isProductionLikeRuntime() &&
          (!configuredSecret ||
            configuredSecret === 'replace-me' ||
            configuredSecret.length < 32)
        ) {
          throw new Error(
            'JWT_SECRET must be a non-default value of at least 32 characters in production',
          );
        }
        const expiresIn =
          configuredExpiry && /^\d+$/.test(configuredExpiry)
            ? Number(configuredExpiry)
            : ('7d' as const);

        return {
          secret: configuredSecret ?? 'local-dev-jwt-secret',
          signOptions: { expiresIn },
        };
      },
    }),
  ],
  controllers: [AuthController, AccountSecurityController],
  providers: [
    AuthService,
    JwtAuthGuard,
    RolesGuard,
    AccountSecurityService,
    SecurityMailService,
  ],
  exports: [AuthService, JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
