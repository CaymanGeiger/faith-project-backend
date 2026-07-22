import { Injectable } from '@nestjs/common';
import { MarketingHandoffDto } from './dto/marketing-handoff.dto';

@Injectable()
export class LeadSmartAdapter {
  async submit(_prospectUserId: string, _dto: MarketingHandoffDto) {
    // TODO: Lead Smart endpoint, auth, and payload contract are unresolved in the design doc.
    return {
      externalSubmissionStatus: 'SUBMITTED' as const,
      externalReference: null,
    };
  }
}
