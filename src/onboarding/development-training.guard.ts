import { CanActivate, Injectable } from '@nestjs/common';
import { DevelopmentTrainingService } from './development-training.service';

@Injectable()
export class DevelopmentTrainingGuard implements CanActivate {
  constructor(private readonly service: DevelopmentTrainingService) {}
  canActivate() {
    this.service.assertEnabled();
    return true;
  }
}
