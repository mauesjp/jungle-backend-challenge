import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';

import { Decimal } from 'decimal.js';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { WalletEntity } from '../infrastructure/persistence/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/enums/wager-transaction.enum.js';

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

  // Consulta uma carteira pelo identificador.
  async get(walletId: string) {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: {
        amount: wallet.balance,
        currency: wallet.currency,
      },
      version: wallet.version,
    };
  }

  // Consulta os lançamentos financeiros de uma carteira.
  async ledger(walletId: string, cursor?: string, rawLimit?: string) {
    await this.get(walletId);

    const limit = rawLimit === undefined ? 50 : Number(rawLimit);

    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    const entries = await this.em.find(
      WalletLedgerEntryEntity,
      { wallet: walletId },
      {
        orderBy: {
          createdAt: 'ASC',
          id: 'ASC',
        },
      },
    );

    // O cursor identifica a última entrada consultada.
    let start = 0;

    if (cursor) {
      let lastId: string;

      try {
        lastId = Buffer.from(cursor, 'base64url').toString('utf8');
      } catch {
        throw new BadRequestException('Invalid cursor');
      }

      const index = entries.findIndex((entry) => entry.id === lastId);

      if (index < 0) {
        throw new BadRequestException('Invalid cursor');
      }

      start = index + 1;
    }

    const page = entries.slice(start, start + limit);

    return {
      entries: page.map((entry) => ({
        id: entry.id,
        transactionId: entry.transaction.id,
        direction: entry.direction,
        amount: {
          amount: entry.amount,
          currency: 'BRL',
        },
        balanceBefore: {
          amount: entry.balanceBefore,
          currency: 'BRL',
        },
        balanceAfter: {
          amount: entry.balanceAfter,
          currency: 'BRL',
        },
        createdAt: entry.createdAt,
      })),
      nextCursor:
        start + limit < entries.length && page.length > 0
          ? Buffer.from(page[page.length - 1].id).toString('base64url')
          : null,
    };
  }

  // Compara o saldo armazenado com o histórico financeiro.
  async reconcile(walletId: string) {
    const wallet = await this.em.findOne(WalletEntity, { id: walletId });

    if (!wallet) {
      throw new NotFoundException('Wallet not found');
    }

    const entries = await this.em.find(
      WalletLedgerEntryEntity,
      { wallet: walletId },
      {
        orderBy: {
          createdAt: 'ASC',
          id: 'ASC',
        },
      },
    );

    let total = new Decimal(0);
    let coherent = true;

    for (const entry of entries) {
      if (!new Decimal(entry.balanceBefore).eq(total)) {
        coherent = false;
      }

      total =
        entry.direction === LedgerDirection.Credit
          ? total.plus(entry.amount)
          : total.minus(entry.amount);

      if (!new Decimal(entry.balanceAfter).eq(total)) {
        coherent = false;
      }
    }

    const stored = new Decimal(wallet.balance);
    const difference = stored.minus(total);

    return {
      walletId,
      storedBalance: {
        amount: stored.toFixed(2),
        currency: wallet.currency,
      },
      calculatedBalance: {
        amount: total.toFixed(2),
        currency: wallet.currency,
      },
      difference: {
        amount: difference.toFixed(2),
        currency: wallet.currency,
      },
      consistent: coherent && difference.isZero(),
      checkedEntries: entries.length,
    };
  }

  // Cria uma carteira e registra o saldo inicial no ledger.
  async create(data: CreateWalletDto) {
    const playerId = data?.playerId;
    const amount = data?.initialBalance?.amount;
    const currency = data?.initialBalance?.currency;

    if (typeof playerId !== 'string' || !playerId.trim()) {
      throw new BadRequestException('Invalid playerId');
    }

    // Por enquanto, apenas BRL é aceito.
    if (currency !== 'BRL') {
      throw new BadRequestException('Only BRL is supported');
    }

    if (typeof amount !== 'string' || !/^\d+(\.\d{1,2})?$/.test(amount)) {
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
            .update(
              JSON.stringify({
                playerId,
                amount: initialAmount,
                currency,
              }),
            )
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
            balance: {
              amount: initialAmount,
              currency,
            },
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
