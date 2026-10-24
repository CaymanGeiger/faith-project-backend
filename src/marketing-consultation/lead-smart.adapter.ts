import { Injectable } from '@nestjs/common';
import { MarketingHandoffDto } from './dto/marketing-handoff.dto';

@Injectable()
export class LeadSmartAdapter {
  submit(_prospectUserId: string, _dto: MarketingHandoffDto) {
    void _prospectUserId;
    void _dto;
    // No LeadSmart contract is configured yet. The app stores the dealer's
    // availability for Hercules follow-up; it must not claim an external handoff.
    return Promise.resolve({
      externalSubmissionStatus: 'NOT_SUBMITTED' as const,
      externalReference: null,
    });
  }
}
