import { Injectable } from '@nestjs/common';
import { UpdateLeadDto } from './dto/update-lead.dto';

@Injectable()
export class LeadApiAdapter {
  syncLeadUpdate(_externalLeadId: string | null, _dto: UpdateLeadDto) {
    void _externalLeadId;
    void _dto;
    // TODO: Lead API host, credentials, and payload contract are unresolved in the design doc.
    return Promise.resolve({ synced: false, reason: 'LEAD_API_UNCONFIGURED' });
  }
}
