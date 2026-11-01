
import { BadRequestException, ConflictException, Injectable,} from '@nestjs/common';
import { EntityManager, UniqueConstraintViolationException } from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';

import { WalletEntity } from '../infrastructure/persistence/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import { WagerTransactionKind, WagerTransactionStatus,} from '../domain/enums/wager-transaction.enum.js';
import { LedgerDirection } from '../domain/enums/ledger-direction.enum.js';

export interface CreateWalletDto {
  playerId: string;
  initialBalance: {
    amount: string;
    currency: string;
  };
}

@Injectable()
export class WalletsService {
  constructor(private readonly em: EntityManager) {}

  async create(data: CreateWalletDto) {
    const playerId = data?.playerId;
    const amount = data?.initialBalance?.amount;
    const currency = data?.initialBalance?.currency;

    if (typeof playerId !== 'string' || !playerId.trim()) {
      throw new BadRequestException('Invalid playerId');
    }

    // Por enquanto, vamos trabalhar apenas com BRL.
    if (currency !== 'BRL') {
      throw new BadRequestException('Only BRL is supported');
    }

    if (
      typeof amount !== 'string' ||
      !/^\d+(\.\d{1,2})?$/.test(amount)
    ) {
      throw new BadRequestException('Invalid amount format');
    }

    const value = new Decimal(amount);

    if (!value.isFinite() || value.isNegative()) {
      throw new BadRequestException('Invalid initial balance');
    }

    const initialAmount = value.toFixed(2);

    try {
      return await this.em.transactional(async (tx) => {
        const wallet = new WalletEntity();
        wallet.playerId = playerId;
        wallet.currency = currency;
        wallet.balance = initialAmount;
        wallet.version = 1;

        tx.persist(wallet);

        if (value.gt(0)) {
          const opening = new WagerTransactionEntity();

          opening.providerId = 'internal';
          opening.externalTransactionId = `opening:${wallet.id}`;
          opening.idempotencyKey = `opening:${wallet.id}`;
          opening.payloadHash = createHash('sha256')
            .update(JSON.stringify({
              playerId,
              amount: initialAmount,
              currency,
            }))
            .digest('hex');

          opening.wallet = wallet;
          opening.playerId = playerId;
          opening.roundId = 'OPENING';
          opening.gameId = 'OPENING';
          opening.kind = WagerTransactionKind.Opening;
          opening.status = WagerTransactionStatus.Processed;
          opening.amount = initialAmount;
          opening.currency = currency;
          opening.processedAt = new Date();
          opening.resultPayload = {
            balance: { amount: initialAmount, currency },
          };

          tx.persist(opening);

          const ledger = new WalletLedgerEntryEntity();
          ledger.wallet = wallet;
          ledger.transaction = opening;
          ledger.direction = LedgerDirection.Credit;
          ledger.amount = initialAmount;
          ledger.balanceBefore = '0.00';
          ledger.balanceAfter = initialAmount;

          tx.persist(ledger);
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: {
            amount: initialAmount,
            currency,
          },
          version: wallet.version,
        };
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new ConflictException(
          'Wallet already exists for this player and currency',
        );
      }

      throw error;
    }
  }
}
