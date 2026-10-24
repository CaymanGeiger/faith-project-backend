import { ServiceUnavailableException } from '@nestjs/common';

export function assertPreviewOperationsConfigured() {
  if (
    process.env.APP_ENV === 'preview' &&
    !process.env.OPERATIONS_WEBHOOK_URL?.trim()
  )
    throw new ServiceUnavailableException(
      'Hercules operations review is not connected in this preview environment. This request was not submitted.',
    );
}
