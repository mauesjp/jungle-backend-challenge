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
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
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

  // Consulta uma transação pelo ID interno.
  async getById(transactionId: string) {
    const transaction = await this.em.findOne(WagerTransactionEntity, {
      id: transactionId,
    });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    return this.toDetails(transaction);
  }

  // Consulta uma transação pelo identificador do provedor.
  async getByProvider(providerId: string, externalTransactionId: string) {
    const transaction = await this.em.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    return this.toDetails(transaction);
  }

  private toDetails(transaction: WagerTransactionEntity) {
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.wallet.id,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      money: {
        amount: transaction.amount,
        currency: transaction.currency,
      },
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
      processedAt: transaction.processedAt ?? null,
      balance: transaction.resultPayload?.balance ?? null,
    };
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

    const allowedKinds = [
      Kind.Bet,
      Kind.Win,
      Kind.Loss,
      Kind.Refund,
      Kind.Rollback,
    ];

    if (!allowedKinds.includes(data.kind as Kind)) {
      throw new BadRequestException('Invalid transaction kind');
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
      throw new BadRequestException('Amount must be positive');
    }

    const kind = data.kind as Kind;
    const isReversal = kind === Kind.Refund || kind === Kind.Rollback;

    const referenceId = data.referenceExternalTransactionId;

    if (isReversal && !referenceId?.trim()) {
      throw new BadRequestException('Reference is required');
    }

    if (kind === Kind.Bet && referenceId !== undefined) {
      throw new BadRequestException('BET cannot have a reference');
    }

    if (
      referenceId !== undefined &&
      (typeof referenceId !== 'string' || !referenceId.trim())
    ) {
      throw new BadRequestException('Invalid reference');
    }

    const normalizedAmount = amount.toFixed(2);

    const payload = {
      providerId: data.providerId,
      externalTransactionId: data.externalTransactionId,
      playerId: data.playerId,
      walletId: data.walletId,
      roundId: data.roundId,
      gameId: data.gameId,
      kind,
      money: {
        amount: normalizedAmount,
        currency: data.money.currency,
      },
      referenceExternalTransactionId: referenceId ?? null,
    };

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');

    // Recupera uma resposta já armazenada.
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

      if (!existing) {
        return null;
      }

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

    if (duplicate) {
      return duplicate;
    }

    try {
      return await this.em.transactional(async (tx) => {
        const wallet = await tx.findOne(
          WalletEntity,
          { id: data.walletId },
          {
            lockMode: LockMode.PESSIMISTIC_WRITE,
          },
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

        // Revalida a idempotência após bloquear a carteira.
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

        const before = new Decimal(wallet.balance);

        const transaction = new WagerTransactionEntity();

        transaction.providerId = data.providerId;
        transaction.externalTransactionId = data.externalTransactionId;
        transaction.idempotencyKey = idempotencyKey;
        transaction.payloadHash = payloadHash;
        transaction.wallet = wallet;
        transaction.playerId = data.playerId;
        transaction.roundId = data.roundId;
        transaction.gameId = data.gameId;
        transaction.kind = kind;
        transaction.amount = normalizedAmount;
        transaction.currency = data.money.currency;

        if (referenceId) {
          transaction.referenceExternalTransactionId = referenceId;
        }

        // Localiza a transação original quando necessário.
        let reference: WagerTransactionEntity | null = null;

        if (referenceId) {
          reference = await tx.findOne(WagerTransactionEntity, {
            providerId: data.providerId,
            externalTransactionId: referenceId,
          });
        }

        let failureCode: string | undefined;

        let pendingReference = false;

        if (isReversal && !reference) {
          pendingReference = true;
        }

        if (reference) {
          const validReference =
            reference.status === Status.Processed &&
            reference.playerId === data.playerId &&
            reference.wallet.id === wallet.id &&
            reference.currency === data.money.currency &&
            reference.roundId === data.roundId &&
            reference.gameId === data.gameId;

          if (!validReference) {
            failureCode = 'INVALID_REFERENCE';
          }

          if (kind === Kind.Refund && reference.kind !== Kind.Bet) {
            failureCode = 'INVALID_REFERENCE_KIND';
          }

          if (
            kind === Kind.Rollback &&
            ![Kind.Bet, Kind.Win, Kind.Refund].includes(reference.kind)
          ) {
            failureCode = 'INVALID_REFERENCE_KIND';
          }

          if (isReversal && !amount.eq(new Decimal(reference.amount))) {
            failureCode = 'AMOUNT_MISMATCH';
          }

          if (isReversal && !failureCode) {
            const previousReversal = await tx.findOne(WagerTransactionEntity, {
              referenceTransactionId: reference.id,
              kind,
              status: Status.Processed,
            });

            if (previousReversal) {
              failureCode = 'ALREADY_REVERSED';
            }
          }

          if (!failureCode) {
            transaction.referenceTransactionId = reference.id;
          }
        }

        // WIN com referência exige uma BET processada.
        if (
          kind === Kind.Win &&
          referenceId &&
          (!reference ||
            reference.kind !== Kind.Bet ||
            reference.status !== Status.Processed ||
            reference.playerId !== data.playerId ||
            reference.wallet.id !== wallet.id ||
            reference.currency !== data.money.currency ||
            reference.roundId !== data.roundId)
        ) {
          failureCode = 'INVALID_BET_REFERENCE';
        }

        let direction: LedgerDirection | null = null;

        if (kind === Kind.Bet) {
          direction = LedgerDirection.Debit;
        } else if (kind === Kind.Win || kind === Kind.Refund) {
          direction = LedgerDirection.Credit;
        } else if (kind === Kind.Rollback && reference) {
          direction =
            reference.kind === Kind.Bet
              ? LedgerDirection.Credit
              : LedgerDirection.Debit;
        }

        let after = before;

        if (!failureCode && !pendingReference && direction) {
          after =
            direction === LedgerDirection.Credit
              ? before.plus(amount)
              : before.minus(amount);

          if (after.isNegative()) {
            failureCode = isReversal
              ? 'REVERSAL_INSUFFICIENT_FUNDS'
              : 'INSUFFICIENT_FUNDS';

            after = before;
          }

          // NUMERIC(20,2) permite até 18 dígitos inteiros.
          if (after.gte(new Decimal('1000000000000000000'))) {
            failureCode = 'BALANCE_LIMIT_EXCEEDED';
            after = before;
          }
        }

        if (pendingReference) {
          transaction.status = Status.PendingReference;
        } else if (failureCode) {
          transaction.status = Status.Rejected;

          transaction.failureCode = failureCode;

          transaction.processedAt = new Date();
        } else {
          transaction.status = Status.Processed;

          transaction.processedAt = new Date();
        }

        const balance = {
          amount: after.toFixed(2),
          currency: wallet.currency,
        };

        transaction.resultPayload = {
          balance,
        };

        tx.persist(transaction);

        // Apenas operações aprovadas movimentam o ledger.
        if (transaction.status === Status.Processed && direction) {
          wallet.balance = after.toFixed(2);

          const ledger = new WalletLedgerEntryEntity();

          ledger.wallet = wallet;
          ledger.transaction = transaction;
          ledger.direction = direction;
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

        if (existing) {
          return existing;
        }
      }

      throw error;
    }
  }
}
