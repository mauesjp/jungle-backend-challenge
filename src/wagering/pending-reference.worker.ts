import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { WagerTransactionEntity } from '../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WagerTransactionStatus as Status } from '../domain/enums/wager-transaction.enum.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { WageringService } from './wagering.service.js';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);

  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;
  private currentCycle?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly wageringService: WageringService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runCycle();
    }, 3000);

    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    // Impede novos ciclos antes de cancelar o agendamento.
    this.stopping = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.currentCycle) {
      this.logger.log({
        event: 'pending_reference_shutdown_waiting',
      });

      // Aguarda a tentativa financeira em andamento terminar.
      await this.currentCycle;
    }

    this.logger.log({
      event: 'pending_reference_shutdown_completed',
    });
  }

  private async runCycle(): Promise<void> {
    // Não inicia ciclos após o shutdown ou em paralelo.
    if (this.stopping || this.running) {
      return;
    }

    this.running = true;

    const cycle = this.processCycle();
    this.currentCycle = cycle;

    try {
      await cycle;
    } finally {
      this.running = false;

      if (this.currentCycle === cycle) {
        this.currentCycle = undefined;
      }
    }
  }

  private async processCycle(): Promise<void> {
    try {
      const now = new Date();

      // Busca até 20 transações com retry vencido.
      const pending = await this.em.fork().find(
        WagerTransactionEntity,
        {
          status: Status.PendingReference,
          $or: [{ nextRetryAt: { $lte: now } }, { nextRetryAt: null }],
        },
        {
          limit: 20,
          orderBy: { createdAt: 'ASC' },
        },
      );

      for (const transaction of pending) {
        // Não inicia outra recuperação após o shutdown.
        if (this.stopping) {
          break;
        }

        const startedAt = performance.now();

        try {
          await this.wageringService.retryPendingTransaction(transaction.id);

          this.logger.log({
            event: 'pending_reference_retry_completed',
            transactionId: transaction.id,
            durationMs: performance.now() - startedAt,
          });
        } catch (error) {
          this.metrics.increment('pending_reference_retries_failed');

          this.logger.error({
            event: 'pending_reference_retry_failed',
            transactionId: transaction.id,
            durationMs: performance.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });
        }
      }
    } catch (error) {
      this.logger.error({
        event: 'pending_reference_worker_failed',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
