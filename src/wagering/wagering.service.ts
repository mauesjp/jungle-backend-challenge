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

export interface CreateWagerDto {
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
  referenceExternalTransactionId?: string;
}

@Injectable()
export class WageringService {
  constructor(private readonly em: EntityManager) {}

  async createBet(data: CreateWagerDto, idempotencyKey: string) {
    return this.process(data, idempotencyKey);
  }

  async process(data: CreateWagerDto, idempotencyKey: string) {
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

    if (required.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new BadRequestException('Missing required fields');
    }

    const isBet = data.kind === WagerTransactionKind.Bet;
    const isWin = data.kind === WagerTransactionKind.Win;
    const isLoss = data.kind === WagerTransactionKind.Loss;

    if (!isBet && !isWin && !isLoss) {
      throw new BadRequestException('Only BET, WIN, and LOSS are supported');
    }

    if (
      data.money?.currency !== 'BRL' ||
      typeof data.money?.amount !== 'string' ||
      !/^\d+(\.\d{1,2})?$/.test(data.money.amount)
    ) {
      throw new BadRequestException('Invalid money');
    }

    if (
      data.referenceExternalTransactionId !== undefined &&
      (typeof data.referenceExternalTransactionId !== 'string' ||
        !data.referenceExternalTransactionId.trim())
    ) {
      throw new BadRequestException('Invalid reference');
    }

    if (isBet && data.referenceExternalTransactionId) {
      throw new BadRequestException('BET cannot reference another transaction');
    }

    const amount = new Decimal(data.money.amount);

    if (!amount.isFinite() || !amount.gt(0)) {
      throw new BadRequestException('Amount must be positive');
    }

    const normalizedAmount = amount.toFixed(2);

    const payload = {
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind: data.kind,
      money: {
        amount: normalizedAmount,
        currency: data.money.currency,
      },
      referenceExternalTransactionId:
        data.referenceExternalTransactionId ?? null,
    };

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');

    const findDuplicate = async () => {
      const existing = await this.em.fork().findOne(WagerTransactionEntity, {
        $or: [
          { idempotencyKey },
          {
            providerId: data.providerId,
            externalTransactionId: data.externalTransactionId,
          },
        ],
      });

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

    const duplicate = await findDuplicate();
    if (duplicate) return duplicate;

    try {
      return await this.em.transactional(async (tx) => {
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

        const existing = await tx.findOne(WagerTransactionEntity, {
          $or: [
            { idempotencyKey },
            {
              providerId: data.providerId,
              externalTransactionId: data.externalTransactionId,
            },
          ],
        });

        if (existing) {
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
        }

        let reference: WagerTransactionEntity | null = null;

        if (data.referenceExternalTransactionId) {
          reference = await tx.findOne(WagerTransactionEntity, {
            providerId: data.providerId,
            externalTransactionId: data.referenceExternalTransactionId,
          });

          if (
            !reference ||
            reference.kind !== WagerTransactionKind.Bet ||
            reference.status !== WagerTransactionStatus.Processed ||
            reference.playerId !== data.playerId ||
            reference.wallet.id !== wallet.id ||
            reference.currency !== data.money.currency ||
            reference.roundId !== data.roundId
          ) {
            throw new BadRequestException('Invalid BET reference');
          }
        }

        const before = new Decimal(wallet.balance);

        const sufficient = !isBet || before.gte(amount);

        const after = isBet
          ? sufficient
            ? before.minus(amount)
            : before
          : isWin
            ? before.plus(amount)
            : before;

        const transaction = new WagerTransactionEntity();

        transaction.providerId = data.providerId;
        transaction.externalTransactionId = data.externalTransactionId;
        transaction.idempotencyKey = idempotencyKey;
        transaction.payloadHash = payloadHash;
        transaction.wallet = wallet;
        transaction.playerId = data.playerId;
        transaction.roundId = data.roundId;
        transaction.gameId = data.gameId;
        transaction.kind = data.kind as WagerTransactionKind;
        transaction.amount = normalizedAmount;
        transaction.currency = data.money.currency;
        transaction.processedAt = new Date();

        if (reference) {
          transaction.referenceTransactionId = reference.id;
          transaction.referenceExternalTransactionId =
            data.referenceExternalTransactionId;
        }

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

        if (sufficient && !isLoss) {
          wallet.balance = after.toFixed(2);

          const ledger = new WalletLedgerEntryEntity();

          ledger.wallet = wallet;
          ledger.transaction = transaction;
          ledger.direction = isWin
            ? LedgerDirection.Credit
            : LedgerDirection.Debit;
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
      if (error instanceof UniqueConstraintViolationException) {
        const existing = await findDuplicate();
        if (existing) return existing;
      }

      throw error;
    }
  }
}
