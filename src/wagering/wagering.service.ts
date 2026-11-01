
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  EntityManager,
  LockMode,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';
import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';

import { WalletEntity } from '../infrastructure/persistence/entities/wallet.entity.js';
import { WagerTransactionEntity } from '../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WalletLedgerEntryEntity } from '../infrastructure/persistence/entities/wallet-ledger-entry.entity.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/enums/wager-transaction.enum.js';
import { LedgerDirection } from '../domain/enums/ledger-direction.enum.js';

export interface CreateBetDto {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: {
    amount: string;
    currency: string;
  };
}

@Injectable()
export class WageringService {
  constructor(private readonly em: EntityManager) {}

  async createBet(data: CreateBetDto, idempotencyKey: string) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key is required');
    }

    const required = [
      data?.providerId,
      data?.externalTransactionId,
      data?.playerId,
      data?.walletId,
      data?.roundId,
      data?.gameId,
    ];

    if (required.some((value) =>
      typeof value !== 'string' || !value.trim()
    )) {
      throw new BadRequestException('Missing required fields');
    }

    if (data.kind !== WagerTransactionKind.Bet) {
      throw new BadRequestException('Only BET is supported');
    }

    if (
      data.money?.currency !== 'BRL' ||
      typeof data.money?.amount !== 'string' ||
      !/^\d+(\.\d{1,2})?$/.test(data.money.amount)
    ) {
      throw new BadRequestException('Invalid money');
    }

    const amount = new Decimal(data.money.amount);

    if (!amount.isFinite() || !amount.gt(0)) {
      throw new BadRequestException('BET amount must be positive');
    }

    const normalizedAmount = amount.toFixed(2);

    // Campos fixos em ordem estável para gerar o hash.
    const payload = {
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: WagerTransactionKind.Bet,
      money: {
        amount: normalizedAmount,
        currency: 'BRL',
      },
    };

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');

    const replay = async () => {
      const existing = await this.em.fork().findOne(
        WagerTransactionEntity,
        {
          $or: [
            { idempotencyKey },
            {
              providerId: data.providerId,
              externalTransactionId: data.externalTransactionId,
            },
          ],
        },
      );

      if (!existing) return null;

      if (
        existing.idempotencyKey !== idempotencyKey ||
        existing.payloadHash !== payloadHash
      ) {
        throw new ConflictException('Idempotency conflict');
      }

      return {
        transactionId: existing.id,
        status: existing.status,
        balance: existing.resultPayload?.balance,
        idempotentReplay: true,
      };
    };

    // Verificação rápida antes da transação.
    const existing = await replay();
    if (existing) return existing;

    try {
      return await this.em.transactional(async (tx) => {
        // O lock protege esta carteira durante o débito.
        const wallet = await tx.findOne(
          WalletEntity,
          { id: data.walletId },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (!wallet) {
          throw new NotFoundException('Wallet not found');
        }

        if (
          wallet.playerId !== data.playerId ||
          wallet.currency !== data.money.currency
        ) {
          throw new BadRequestException('Wallet mismatch');
        }

        // Verificar novamente depois de obter o lock.
        const duplicate = await tx.findOne(
          WagerTransactionEntity,
          {
            $or: [
              { idempotencyKey },
              {
                providerId: data.providerId,
                externalTransactionId: data.externalTransactionId,
              },
            ],
          },
        );

        if (duplicate) {
          if (
            duplicate.idempotencyKey !== idempotencyKey ||
            duplicate.payloadHash !== payloadHash
          ) {
            throw new ConflictException('Idempotency conflict');
          }

          return {
            transactionId: duplicate.id,
            status: duplicate.status,
            balance: duplicate.resultPayload?.balance,
            idempotentReplay: true,
          };
        }

        const before = new Decimal(wallet.balance);
        const sufficient = before.gte(amount);
        const after = sufficient
          ? before.minus(amount)
          : before;

        const transaction = new WagerTransactionEntity();
        transaction.providerId = data.providerId;
        transaction.externalTransactionId =
          data.externalTransactionId;
        transaction.idempotencyKey = idempotencyKey;
        transaction.payloadHash = payloadHash;
        transaction.wallet = wallet;
        transaction.playerId = data.playerId;
        transaction.roundId = data.roundId;
        transaction.gameId = data.gameId;
        transaction.kind = WagerTransactionKind.Bet;
        transaction.amount = normalizedAmount;
        transaction.currency = data.money.currency;
        transaction.processedAt = new Date();

        transaction.status = sufficient
          ? WagerTransactionStatus.Processed
          : WagerTransactionStatus.Rejected;

        if (!sufficient) {
          transaction.failureCode = 'INSUFFICIENT_FUNDS';
        }

        const balance = {
          amount: after.toFixed(2),
          currency: wallet.currency,
        };

        transaction.resultPayload = { balance };
        tx.persist(transaction);

        if (sufficient) {
          wallet.balance = after.toFixed(2);

          const ledger = new WalletLedgerEntryEntity();
          ledger.wallet = wallet;
          ledger.transaction = transaction;
          ledger.direction = LedgerDirection.Debit;
          ledger.amount = normalizedAmount;
          ledger.balanceBefore = before.toFixed(2);
          ledger.balanceAfter = after.toFixed(2);

          tx.persist(ledger);
        }

        await tx.flush();

        return {
          transactionId: transaction.id,
          status: transaction.status,
          balance,
          idempotentReplay: false,
        };
      });
    } catch (error) {
      // Outra requisição pode ter inserido a operação primeiro.
      if (error instanceof UniqueConstraintViolationException) {
        const existing = await replay();
        if (existing) return existing;
      }

      throw error;
    }
  }
}
