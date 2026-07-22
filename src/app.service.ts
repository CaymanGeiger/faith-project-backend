import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth() {
    return {
      name: 'Hercules Honors Rewards Member API',
      status: 'ok',
    };
  }
}
