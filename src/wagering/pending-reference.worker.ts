import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import { WagerTransactionEntity } from '../infrastructure/persistence/entities/wager-transaction.entity.js';
import { WagerTransactionStatus as Status } from '../domain/enums/wager-transaction.enum.js';
import { WageringService } from './wagering.service.js';

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly em: EntityManager,
    private readonly wageringService: WageringService,
  ) {}

  onModuleInit() {
    // Executa o worker periodicamente sem sobrepor ciclos.
    this.timer = setInterval(() => {
      void this.runCycle();
    }, 3000);

    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async runCycle() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const now = new Date();

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
        try {
          await this.wageringService.retryPendingTransaction(transaction.id);
        } catch (error) {
          this.logger.error(
            `Failed to retry transaction ${transaction.id}`,
            error instanceof Error ? error.stack : String(error),
          );
        }
      }
    } catch (error) {
      this.logger.error(
        'Pending reference worker failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
