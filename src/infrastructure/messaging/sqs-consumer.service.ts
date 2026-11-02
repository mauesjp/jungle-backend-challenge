import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { SqsService } from './sqs.service.js';
import { MetricsService } from '../../metrics/metrics.service.js';

import {
  WageringService,
  type CreateWagerDto,
} from '../../wagering/wagering.service.js';

interface WagerTransactionRequested {
  messageId: string;
  type: 'WagerTransactionRequested';
  occurredAt: string;
  data: CreateWagerDto & {
    idempotencyKey: string;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Valida o envelope antes de iniciar o processamento financeiro.
export function parseWagerMessage(body: string): WagerTransactionRequested {
  const payload: unknown = JSON.parse(body);

  if (!isObject(payload)) {
    throw new Error('Invalid SQS message payload');
  }

  if (
    typeof payload.messageId !== 'string' ||
    !payload.messageId.trim() ||
    payload.type !== 'WagerTransactionRequested' ||
    typeof payload.occurredAt !== 'string' ||
    !payload.occurredAt.trim() ||
    !Number.isFinite(Date.parse(payload.occurredAt)) ||
    !isObject(payload.data)
  ) {
    throw new Error('Invalid SQS message envelope');
  }

  const data = payload.data;

  if (typeof data.idempotencyKey !== 'string' || !data.idempotencyKey.trim()) {
    throw new Error('Invalid SQS idempotency key');
  }

  return payload as unknown as WagerTransactionRequested;
}

@Injectable()
export class SqsConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SqsConsumerService.name);

  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;
  private currentCycle?: Promise<void>;

  constructor(
    private readonly sqs: SqsService,
    private readonly wageringService: WageringService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.poll();
    }, 1000);

    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    // Impede novos ciclos e cancela o agendamento.
    this.stopping = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    // Aguarda o ciclo que já estava em andamento.
    if (this.currentCycle) {
      this.logger.log({
        event: 'sqs_consumer_shutdown_waiting',
      });

      await this.currentCycle;
    }

    this.logger.log({
      event: 'sqs_consumer_shutdown_completed',
    });
  }

  private async poll(): Promise<void> {
    // Não inicia ciclos durante o desligamento ou em paralelo.
    if (this.stopping || this.running) {
      return;
    }

    this.running = true;

    const cycle = this.processMessages();
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

  private async processMessages(): Promise<void> {
    try {
      const messages = await this.sqs.receive();

      for (const message of messages) {
        const startedAt = performance.now();

        if (!message.MessageId || !message.ReceiptHandle || !message.Body) {
          this.metrics.increment('sqs_messages_failed');

          this.logger.warn({
            event: 'sqs_message_missing_metadata',
            sqsMessageId: message.MessageId ?? null,
            hasReceiptHandle: Boolean(message.ReceiptHandle),
            hasBody: Boolean(message.Body),
          });

          continue;
        }

        let businessMessageId: string | undefined;

        try {
          const payload = parseWagerMessage(message.Body);
          businessMessageId = payload.messageId;

          const { idempotencyKey, ...transaction } = payload.data;

          // Processa a operação financeira dentro da transação.
          const result = await this.wageringService.processFromQueue(
            payload.messageId,
            transaction,
            idempotencyKey,
          );

          // Confirma somente depois do processamento financeiro.
          await this.sqs.acknowledge(message.ReceiptHandle);

          this.metrics.increment('sqs_messages_processed');

          if (result.alreadyProcessed) {
            this.metrics.increment('sqs_messages_duplicate');
          }

          this.logger.log({
            event: 'sqs_message_processed',
            messageId: payload.messageId,
            sqsMessageId: message.MessageId,
            idempotencyKey,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            walletId: transaction.walletId,
            duplicate: result.alreadyProcessed,
          });
        } catch (error) {
          this.metrics.increment('sqs_messages_failed');

          this.logger.error({
            event: 'sqs_message_failed',
            messageId: businessMessageId ?? null,
            sqsMessageId: message.MessageId,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });

          // Sem ACK: a mensagem continua sujeita a redelivery e DLQ.
        } finally {
          this.metrics.observe(
            'sqs_processing_ms',
            performance.now() - startedAt,
          );
        }
      }
    } catch (error) {
      this.metrics.increment('sqs_polling_failed');

      this.logger.error({
        event: 'sqs_polling_failed',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
