import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { WalletsService, type CreateWalletDto } from './wallets.service.js';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  create(@Body() body: CreateWalletDto) {
    return this.walletsService.create(body);
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.walletsService.get(walletId);
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.walletsService.ledger(walletId, cursor, limit);
  }

  @Post(':walletId/reconciliation')
  reconcile(@Param('walletId') walletId: string) {
    return this.walletsService.reconcile(walletId);
  }
}
