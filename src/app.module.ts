import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { WalletEntity } from './infrastructure/persistence/entities/wallet.entity.js';
import { Migrator } from '@mikro-orm/migrations';

import { WagerTransactionEntity } from './infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from './infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WageringController } from './wagering/wagering.controller.js';
import { WageringService } from './wagering/wagering.service.js';
import { WalletsController } from './wallets/wallets.controller.js';
import { WalletsService } from './wallets/wallets.service.js';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),

    MikroOrmModule.forRootAsync({
      inject: [ConfigService],
      driver: PostgreSqlDriver,
      useFactory: (config: ConfigService) => ({
        extensions: [Migrator],
        driver: PostgreSqlDriver,
        host: config.getOrThrow<string>('DB_HOST'),
        port: Number(config.getOrThrow<string>('DB_PORT')),
        user: config.getOrThrow<string>('DB_USER'),
        password: config.getOrThrow<string>('DB_PASSWORD'),
        dbName: config.getOrThrow<string>('DB_NAME'),
        entities: [
          WalletEntity,
          WagerTransactionEntity,
          WalletLedgerEntryEntity,
        ],
        allowGlobalContext: false,
      }),
    }),
  ],
  controllers: [AppController, WalletsController, WageringController],
  providers: [AppService, WalletsService, WageringService],
})
export class AppModule {}
