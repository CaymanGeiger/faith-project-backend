import { Injectable } from '@nestjs/common';
import { UpdateLeadDto } from './dto/update-lead.dto';

@Injectable()
export class LeadApiAdapter {
  async syncLeadUpdate(_externalLeadId: string | null, _dto: UpdateLeadDto) {
    // TODO: Lead API host, credentials, and payload contract are unresolved in the design doc.
    return { synced: false, reason: 'LEAD_API_UNCONFIGURED' };
  }
}
