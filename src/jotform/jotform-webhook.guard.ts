import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  PayloadTooLargeException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { JOTFORM_CONFIG, JotformConfig } from './jotform.config';
import { verifyJotformWebhookSecret } from './jotform-webhook.parser';

/** Rejects unauthenticated multipart calls before Multer reads their fields. */
@Injectable()
export class JotformWebhookGuard implements CanActivate {
  constructor(
    @Inject(JOTFORM_CONFIG) private readonly config: Readonly<JotformConfig>,
  ) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const headerCandidate = singleHeaderValue(
      request.headers['x-jotform-webhook-secret'],
    );
    const basicCandidate = parseBasicWebhookSecret(
      singleHeaderValue(request.headers.authorization),
    );
    // Evaluate both credential slots before combining the result so a caller
    // cannot use short-circuit timing to distinguish the configured method.
    const headerMatches = verifyJotformWebhookSecret(
      headerCandidate,
      this.config.webhookSecret,
      this.config.previousWebhookSecret,
    );
    const basicMatches = verifyJotformWebhookSecret(
      basicCandidate,
      this.config.webhookSecret,
      this.config.previousWebhookSecret,
    );
    if (!this.config.enabled || (!headerMatches && !basicMatches)) {
      throw new NotFoundException();
    }
    const contentLength = singleHeaderValue(request.headers['content-length']);
    if (!contentLength || !/^\d+$/.test(contentLength)) {
      throw new BadRequestException('Jotform webhook requires Content-Length');
    }
    if (Number(contentLength) > 2_500_000) {
      throw new PayloadTooLargeException('Jotform webhook body is too large');
    }
    return true;
  }
}

function singleHeaderValue(value: string | string[] | undefined) {
  return typeof value === 'string' ? value : undefined;
}

function parseBasicWebhookSecret(authorization: string | undefined) {
  if (!authorization || authorization.length > 8_192) {
    return undefined;
  }

  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/.exec(authorization);
  if (!match || match[1].length % 4 === 1) {
    return undefined;
  }

  const encoded = match[1];
  let decoded: string;
  try {
    const bytes = Buffer.from(encoded, 'base64');
    if (
      bytes.toString('base64').replace(/=+$/u, '') !==
      encoded.replace(/=+$/u, '')
    ) {
      return undefined;
    }
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }

  const separator = decoded.indexOf(':');
  if (separator === -1 || decoded.slice(0, separator) !== 'jotform') {
    return undefined;
  }
  return decoded.slice(separator + 1);
}
