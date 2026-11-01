import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletEntity } from './src/infrastructure/persistence/entities/wallet.entity.js';
import 'dotenv/config';

import { WagerTransactionEntity } from './src/infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from './src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? '5432'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  dbName: process.env.DB_NAME,

  entities: [WalletEntity, WagerTransactionEntity, WalletLedgerEntryEntity],
  extensions: [Migrator],

  migrations: {
    path: './migrations',
    pathTs: './migrations',
  },
});
