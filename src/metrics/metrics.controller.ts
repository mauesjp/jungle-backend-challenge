import { Controller, Get } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  getMetrics() {
    return this.metrics.snapshot();
  }
}
