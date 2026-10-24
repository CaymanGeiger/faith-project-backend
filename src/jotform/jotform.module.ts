import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { JotformApiClient } from './jotform-api.client';
import {
  JOTFORM_CONFIG,
  JotformConfig,
  loadJotformConfig,
} from './jotform.config';
import { JotformReconciliationService } from './jotform-reconciliation.service';
import { JOTFORM_API_CLIENT, JotformSyncService } from './jotform-sync.service';
import { JotformWebhookController } from './jotform-webhook.controller';
import { JotformWebhookGuard } from './jotform-webhook.guard';

@Module({
  imports: [PrismaModule],
  controllers: [JotformWebhookController],
  providers: [
    {
      provide: JOTFORM_CONFIG,
      useFactory: () => loadJotformConfig(),
    },
    {
      provide: JOTFORM_API_CLIENT,
      inject: [JOTFORM_CONFIG],
      useFactory: (config: Readonly<JotformConfig>) => {
        if (!config.enabled) {
          return null;
        }
        if (!config.apiKey) {
          throw new Error('JOTFORM_API_KEY is required');
        }
        return new JotformApiClient({
          apiKey: config.apiKey,
          baseUrl: config.apiBaseUrl,
          timeoutMs: config.requestTimeoutMs,
        });
      },
    },
    JotformSyncService,
    JotformReconciliationService,
    JotformWebhookGuard,
  ],
  exports: [
    JOTFORM_CONFIG,
    JOTFORM_API_CLIENT,
    JotformSyncService,
    JotformReconciliationService,
  ],
})
export class JotformModule {}
