import { Body, Controller, Post } from '@nestjs/common';
import { WalletsService, type CreateWalletDto } from './wallets.service.js';

@Controller('wallets')
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Post()
  async create(@Body() body: CreateWalletDto) {
    return this.walletsService.create(body);
  }
}
