import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { WalletEntity } from './src/infrastructure/persistence/entities/wallet.entity.js';
import 'dotenv/config';

export default defineConfig({
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? '5432'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  dbName: process.env.DB_NAME,

  entities: [WalletEntity],
  extensions: [Migrator],

  migrations: {
    path: './migrations',
    pathTs: './migrations',
  },
});