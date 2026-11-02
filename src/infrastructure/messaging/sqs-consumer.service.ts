import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { SqsService } from './sqs.service.js';
import {
  WageringService,
  type CreateWagerDto,
} from '../../wagering/wagering.service.js';

interface WagerQueueMessage {
  idempotencyKey: string;
  transaction: CreateWagerDto;
}

@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly sqs: SqsService,
    private readonly wageringService: WageringService,
  ) {}

  onModuleInit() {
    // Evita iniciar outro ciclo enquanto houver um em execução.
    this.timer = setInterval(() => {
      void this.poll();
    }, 1000);

    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async poll() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      const messages = await this.sqs.receive();

      for (const message of messages) {
        if (!message.MessageId || !message.ReceiptHandle || !message.Body) {
          this.logger.warn('SQS message missing required metadata');
          continue;
        }

        try {
          const payload = JSON.parse(message.Body) as WagerQueueMessage;

          if (
            !payload ||
            typeof payload.idempotencyKey !== 'string' ||
            !payload.transaction ||
            typeof payload.transaction !== 'object'
          ) {
            throw new Error('Invalid SQS message payload');
          }

          const result = await this.wageringService.processFromQueue(
            message.MessageId,
            payload.transaction,
            payload.idempotencyKey,
          );

          // Somente confirma após o banco concluir.
          await this.sqs.acknowledge(message.ReceiptHandle);

          this.logger.log(
            `Processed SQS message ${message.MessageId}: ${
              result.alreadyProcessed ? 'duplicate' : 'completed'
            }`,
          );
        } catch (error) {
          this.logger.error(
            `Failed to process SQS message ${message.MessageId}`,
            error instanceof Error ? error.stack : String(error),
          );

          // Não confirma: o SQS poderá entregar novamente.
          // Após o limite configurado, a mensagem irá para a DLQ.
        }
      }
    } catch (error) {
      this.logger.error(
        'SQS polling failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
