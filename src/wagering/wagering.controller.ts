import {
  Body,
  Controller,
  Headers,
  Post,
} from '@nestjs/common';
import {
  WageringService,
  type CreateBetDto,
} from './wagering.service.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly wageringService: WageringService) {}

  @Post()
  create(
    @Body() body: CreateBetDto,
    @Headers('idempotency-key') key: string,
  ) {
    return this.wageringService.createBet(body, key);
  }
}
