import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  ServiceUnavailableException,
  UnsupportedMediaTypeException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { JOTFORM_CONFIG, JotformConfig } from './jotform.config';
import { JotformSyncService } from './jotform-sync.service';
import { JotformWebhookGuard } from './jotform-webhook.guard';
import {
  JotformWebhookParseError,
  parseJotformWebhookEnvelope,
} from './jotform-webhook.parser';

@ApiExcludeController()
@Controller('integrations/jotform/webhooks')
export class JotformWebhookController {
  constructor(
    @Inject(JOTFORM_CONFIG) private readonly config: Readonly<JotformConfig>,
    private readonly sync: JotformSyncService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @UseGuards(JotformWebhookGuard)
  @UseInterceptors(
    AnyFilesInterceptor({
      limits: {
        fieldNameSize: 256,
        fieldSize: 2_000_000,
        fields: 64,
        files: 0,
        parts: 64,
      },
    }),
  )
  async receive(
    @Headers('content-type') contentType: string | undefined,
    @Body() body: unknown,
  ) {
    if (!isSupportedContentType(contentType)) {
      throw new UnsupportedMediaTypeException(
        'Unsupported Jotform webhook content type',
      );
    }

    let envelope;
    try {
      envelope = parseJotformWebhookEnvelope(body);
    } catch (error: unknown) {
      if (error instanceof JotformWebhookParseError) {
        throw new BadRequestException('Invalid Jotform webhook envelope');
      }
      throw error;
    }
    if (envelope.formId !== this.config.formId) {
      throw new BadRequestException('Jotform form is not configured');
    }

    try {
      return await this.sync.acceptWebhook(envelope);
    } catch {
      // A non-2xx response is intentional here: the durable insert did not
      // complete. Scheduled API reconciliation remains the final fallback.
      throw new ServiceUnavailableException(
        'Jotform webhook could not be durably accepted',
      );
    }
  }
}

function isSupportedContentType(contentType: string | undefined) {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
  return (
    mediaType === 'multipart/form-data' ||
    mediaType === 'application/x-www-form-urlencoded' ||
    mediaType === 'application/json'
  );
}
