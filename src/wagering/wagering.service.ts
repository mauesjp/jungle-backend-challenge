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
import { InboxMessageEntity } from '../infrastructure/persistence/entities/inbox-message.entity.js';
import { OutboxMessageEntity } from '../infrastructure/persistence/entities/outbox-message.entity.js';

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

  private readonly maxRetryAttempts = 5;

  // Registra eventos na outbox dentro da transação financeira.
  private addOutboxEvent(
    tx: EntityManager,
    wallet: WalletEntity,
    transaction: WagerTransactionEntity,
    eventType:
      | 'WagerTransactionProcessed'
      | 'WagerTransactionRejected'
      | 'WalletBalanceChanged'
      | 'WagerTransactionPendingReference',
    data: Record<string, unknown>,
  ): void {
    const event = new OutboxMessageEntity();

    event.aggregateId = wallet.id;
    event.eventType = eventType;
    event.occurredAt = new Date();

    // O payload contém um snapshot completo do evento.
    event.payload = {
      eventId: event.id,
      eventType,
      aggregateId: wallet.id,
      correlationId: transaction.id,
      causationId: transaction.referenceTransactionId ?? null,
      occurredAt: event.occurredAt.toISOString(),
      version: 1,
      data,
    };

    tx.persist(event);
  }

  private response(transaction: WagerTransactionEntity, replay = false) {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.resultPayload?.balance,
      idempotentReplay: replay,
    };
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
      retryAttempts: transaction.retryAttempts,
      nextRetryAt: transaction.nextRetryAt ?? null,
      balance: transaction.resultPayload?.balance ?? null,
    };
  }

  async getById(transactionId: string) {
    const transaction = await this.em.findOne(WagerTransactionEntity, {
      id: transactionId,
    });

    if (!transaction) {
      throw new NotFoundException('Transaction not found');
    }

    return this.toDetails(transaction);
  }

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

  private findExisting(
    em: EntityManager,
    data: CreateWagerDto,
    idempotencyKey: string,
  ) {
    return em.findOne(WagerTransactionEntity, {
      $or: [
        { idempotencyKey },
        {
          providerId: data.providerId,
          externalTransactionId: data.externalTransactionId,
        },
      ],
    });
  }

  private checkReplay(
    transaction: WagerTransactionEntity,
    idempotencyKey: string,
    payloadHash: string,
  ) {
    if (
      transaction.idempotencyKey !== idempotencyKey ||
      transaction.payloadHash !== payloadHash
    ) {
      throw new ConflictException('Idempotency conflict');
    }

    return this.response(transaction, true);
  }

  private async findReference(
    em: EntityManager,
    transaction: WagerTransactionEntity,
  ) {
    if (!transaction.referenceExternalTransactionId) {
      return null;
    }

    return em.findOne(WagerTransactionEntity, {
      providerId: transaction.providerId,
      externalTransactionId: transaction.referenceExternalTransactionId,
    });
  }

  // Aplica as regras de uma operação utilizando a carteira bloqueada.
  private async applyTransaction(
    tx: EntityManager,
    wallet: WalletEntity,
    transaction: WagerTransactionEntity,
    allowPending: boolean,
  ) {
    const amount = new Decimal(transaction.amount);
    const before = new Decimal(wallet.balance);
    const kind = transaction.kind;

    const isReversal = kind === Kind.Refund || kind === Kind.Rollback;

    let reference = await this.findReference(tx, transaction);
    let failureCode: string | undefined;

    if (isReversal && !reference) {
      if (allowPending) {
        transaction.status = Status.PendingReference;
        transaction.nextRetryAt = new Date(Date.now() + 2000);

        transaction.resultPayload = {
          balance: {
            amount: before.toFixed(2),
            currency: wallet.currency,
          },
        };

        this.addOutboxEvent(
          tx,
          wallet,
          transaction,
          'WagerTransactionPendingReference',
          {
            transactionId: transaction.id,
            walletId: wallet.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId,
            status: transaction.status,
          },
        );

        await tx.flush();
        return;
      }

      // A referência continua ausente durante uma tentativa do worker.
      transaction.retryAttempts += 1;

      if (transaction.retryAttempts >= this.maxRetryAttempts) {
        transaction.status = Status.Rejected;
        transaction.failureCode = 'REFERENCE_NOT_FOUND';
        transaction.processedAt = new Date();
        transaction.nextRetryAt = undefined;
      } else {
        const delay = 2000 * 2 ** transaction.retryAttempts;

        transaction.nextRetryAt = new Date(Date.now() + delay);
      }

      // Publica rejeição somente quando as tentativas se esgotam.
      if (transaction.status === Status.Rejected) {
        this.addOutboxEvent(
          tx,
          wallet,
          transaction,
          'WagerTransactionRejected',
          {
            transactionId: transaction.id,
            walletId: wallet.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            kind: transaction.kind,
            status: transaction.status,
            failureCode: transaction.failureCode,
            referenceExternalTransactionId:
              transaction.referenceExternalTransactionId,
          },
        );
      }

      await tx.flush();
      return;
    }

    if (reference) {
      const validReference =
        reference.status === Status.Processed &&
        reference.playerId === transaction.playerId &&
        reference.wallet.id === wallet.id &&
        reference.currency === transaction.currency &&
        reference.roundId === transaction.roundId &&
        reference.gameId === transaction.gameId;

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
        const previous = await tx.findOne(WagerTransactionEntity, {
          referenceTransactionId: reference.id,
          kind,
          status: Status.Processed,
        });

        if (previous && previous.id !== transaction.id) {
          failureCode = 'ALREADY_REVERSED';
        }
      }

      if (!failureCode) {
        transaction.referenceTransactionId = reference.id;
      }
    }

    // WIN pode ser independente ou referenciar uma BET processada.
    if (
      kind === Kind.Win &&
      transaction.referenceExternalTransactionId &&
      (!reference ||
        reference.kind !== Kind.Bet ||
        reference.status !== Status.Processed ||
        reference.playerId !== transaction.playerId ||
        reference.wallet.id !== wallet.id ||
        reference.currency !== transaction.currency ||
        reference.roundId !== transaction.roundId)
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

    if (!failureCode && direction) {
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

      if (after.gte('1000000000000000000')) {
        failureCode = 'BALANCE_LIMIT_EXCEEDED';
        after = before;
      }
    }

    transaction.status = failureCode ? Status.Rejected : Status.Processed;

    transaction.failureCode = failureCode;
    transaction.processedAt = new Date();
    transaction.nextRetryAt = undefined;

    transaction.resultPayload = {
      balance: {
        amount: after.toFixed(2),
        currency: wallet.currency,
      },
    };

    if (transaction.status === Status.Processed && direction) {
      wallet.balance = after.toFixed(2);

      const ledger = new WalletLedgerEntryEntity();
      ledger.wallet = wallet;
      ledger.transaction = transaction;
      ledger.direction = direction;
      ledger.amount = transaction.amount;
      ledger.balanceBefore = before.toFixed(2);
      ledger.balanceAfter = after.toFixed(2);

      tx.persist(ledger);
    }

    // Persiste as alterações financeiras na transação atual.
    // O commit só ocorre quando a transação externa terminar.
    await tx.flush();

    const transactionData = {
      transactionId: transaction.id,
      walletId: wallet.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      status: transaction.status,
      money: {
        amount: transaction.amount,
        currency: transaction.currency,
      },
      failureCode: transaction.failureCode ?? null,
    };

    if (transaction.status === Status.Processed) {
      this.addOutboxEvent(
        tx,
        wallet,
        transaction,
        'WagerTransactionProcessed',
        transactionData,
      );
    }

    if (transaction.status === Status.Rejected) {
      this.addOutboxEvent(
        tx,
        wallet,
        transaction,
        'WagerTransactionRejected',
        transactionData,
      );
    }

    // Somente gera evento de saldo quando houve movimentação.
    if (transaction.status === Status.Processed && direction) {
      this.addOutboxEvent(tx, wallet, transaction, 'WalletBalanceChanged', {
        walletId: wallet.id,
        transactionId: transaction.id,
        direction,
        money: {
          amount: transaction.amount,
          currency: transaction.currency,
        },
        balanceBefore: before.toFixed(2),
        balanceAfter: after.toFixed(2),
        walletVersion: wallet.version,
      });
    }

    await tx.flush();
  }

  async process(data: CreateWagerDto, idempotencyKey: string) {
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
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

    // LOSS pode ter valor zero; as demais operações exigem valor positivo.
    const kind = data.kind as Kind;

    if (
      !amount.isFinite() ||
      amount.isNegative() ||
      (amount.isZero() && kind !== Kind.Loss)
    ) {
      throw new BadRequestException('Invalid transaction amount');
    }

    const referenceId = data.referenceExternalTransactionId;

    if (
      (kind === Kind.Refund || kind === Kind.Rollback) &&
      (typeof referenceId !== 'string' || !referenceId.trim())
    ) {
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

    const payloadHash = createHash('sha256')
      .update(
        JSON.stringify({
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
        }),
      )
      .digest('hex');

    const existing = await this.findExisting(
      this.em.fork(),
      data,
      idempotencyKey,
    );

    if (existing) {
      return this.checkReplay(existing, idempotencyKey, payloadHash);
    }

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

        const duplicate = await this.findExisting(tx, data, idempotencyKey);

        if (duplicate) {
          return this.checkReplay(duplicate, idempotencyKey, payloadHash);
        }

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

        tx.persist(transaction);

        await this.applyTransaction(tx, wallet, transaction, true);

        return this.response(transaction);
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        const found = await this.findExisting(
          this.em.fork(),
          data,
          idempotencyKey,
        );

        if (found) {
          return this.checkReplay(found, idempotencyKey, payloadHash);
        }
      }

      throw error;
    }
  }

  // Reprocessa uma transação pendente usando as mesmas regras.
  async retryPendingTransaction(transactionId: string) {
    return this.em.transactional(async (tx) => {
      const pending = await tx.findOne(WagerTransactionEntity, {
        id: transactionId,
      });

      if (!pending || pending.status !== Status.PendingReference) {
        return;
      }

      if (pending.nextRetryAt && pending.nextRetryAt.getTime() > Date.now()) {
        return;
      }

      // A carteira é sempre bloqueada antes de alterar o saldo.
      const wallet = await tx.findOne(
        WalletEntity,
        { id: pending.wallet.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!wallet) {
        throw new NotFoundException('Wallet not found');
      }

      // Bloqueia também a transação, impedindo dois workers.
      const transaction = await tx.findOne(
        WagerTransactionEntity,
        { id: transactionId },
        {
          lockMode: LockMode.PESSIMISTIC_WRITE,
          refresh: true,
        },
      );

      if (!transaction || transaction.status !== Status.PendingReference) {
        return;
      }

      if (
        transaction.nextRetryAt &&
        transaction.nextRetryAt.getTime() > Date.now()
      ) {
        return;
      }

      await this.applyTransaction(tx, wallet, transaction, false);
    });
  }

  // Processa uma mensagem SQS e registra sua conclusão na inbox.
  async processFromQueue(
    messageId: string,
    data: CreateWagerDto,
    idempotencyKey: string,
  ) {
    if (!messageId || typeof messageId !== 'string') {
      throw new BadRequestException('Invalid SQS message ID');
    }

    const payloadHash = createHash('sha256')
      .update(JSON.stringify({ data, idempotencyKey }))
      .digest('hex');

    return this.em.transactional(async (tx) => {
      const existing = await tx.findOne(InboxMessageEntity, {
        consumerName: 'wagering-consumer',
        messageId,
      });

      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new ConflictException('Inbox message payload conflict');
        }

        if (!existing.processedAt) {
          throw new ConflictException('Inbox message is not completed');
        }

        return { alreadyProcessed: true };
      }

      const inbox = new InboxMessageEntity();
      inbox.consumerName = 'wagering-consumer';
      inbox.messageId = messageId;
      inbox.payloadHash = payloadHash;

      tx.persist(inbox);

      // O processamento financeiro utiliza a transação ativa.
      const result = await this.process(data, idempotencyKey);

      inbox.processedAt = new Date();

      await tx.flush();

      return {
        alreadyProcessed: false,
        result,
      };
    });
  }
}
