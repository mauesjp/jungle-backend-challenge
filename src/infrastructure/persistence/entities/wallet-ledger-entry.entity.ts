import { randomUUID } from 'node:crypto';
import {
  Entity,
  PrimaryKey,
  Property,
  ManyToOne,
  Unique,
} from '@mikro-orm/decorators/legacy';

import { WalletEntity } from './wallet.entity.js';
import { WagerTransactionEntity } from './wager-transaction.entity.js';
import { LedgerDirection } from '../../../domain/enums/ledger-direction.enum.js';

@Entity({ tableName: 'wallet_ledger_entries' })
@Unique({ properties: ['wallet', 'transaction'] })
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id: string = randomUUID();

  @ManyToOne(() => WalletEntity, {
    fieldName: 'wallet_id',
  })
  wallet!: WalletEntity;

  @ManyToOne(() => WagerTransactionEntity, {
    fieldName: 'transaction_id',
  })
  transaction!: WagerTransactionEntity;

  @Property({ type: 'string', length: 10 })
  direction!: LedgerDirection;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  amount!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceBefore!: string;

  @Property({ type: 'decimal', precision: 20, scale: 2 })
  balanceAfter!: string;

  @Property({ type: 'datetime' })
  createdAt: Date = new Date();
}
