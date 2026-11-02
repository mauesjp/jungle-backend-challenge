import { Controller, Get, Param } from '@nestjs/common';
import { WageringService } from './wagering.service.js';

@Controller('providers/:providerId/wagering/transactions')
export class ProviderTransactionsController {
  constructor(private readonly wageringService: WageringService) {}

  @Get(':externalTransactionId')
  get(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId')
    externalTransactionId: string,
  ) {
    return this.wageringService.getByProvider(
      providerId,
      externalTransactionId,
    );
  }
}
