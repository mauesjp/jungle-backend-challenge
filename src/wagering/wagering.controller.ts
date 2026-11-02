import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';

import { WageringService, type CreateWagerDto } from './wagering.service.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly wageringService: WageringService) {}

  @Post()
  create(
    @Body() body: CreateWagerDto,
    @Headers('idempotency-key') key: string,
  ) {
    return this.wageringService.process(body, key);
  }

  @Get(':transactionId')
  get(@Param('transactionId') transactionId: string) {
    return this.wageringService.getById(transactionId);
  }
}
