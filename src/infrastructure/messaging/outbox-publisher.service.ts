import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

import { MetricsService } from '../../metrics/metrics.service.js';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  occurred_at: Date | string;
}

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopping = false;
  private currentCycle?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
  ) {
    const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:4566';

    this.queueUrl =
      process.env.SQS_EVENTS_URL ??
      `${endpoint}/000000000000/wager-events.fifo`;

    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      endpoint,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runCycle();
    }, 2000);

    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    // Impede novos ciclos antes de liberar recursos.
    this.stopping = true;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }

    if (this.currentCycle) {
      this.logger.log({
        event: 'outbox_shutdown_waiting',
      });

      // Aguarda a publicação e a persistência de seu resultado.
      await this.currentCycle;
    }

    // O cliente SQS só é destruído após o ciclo terminar.
    this.client.destroy();

    this.logger.log({
      event: 'outbox_shutdown_completed',
    });
  }

  private async claimNext(): Promise<OutboxRow | null> {
    const em = this.em.fork();

    // Reserva atomicamente um evento disponível.
    const rows = await em.execute<OutboxRow[]>(`
      UPDATE outbox_messages
      SET
        attempts = attempts + 1,
        next_attempt_at = NOW() + INTERVAL '60 seconds'
      WHERE id = (
        SELECT id
        FROM outbox_messages
        WHERE published_at IS NULL
          AND (
            next_attempt_at IS NULL
            OR next_attempt_at <= NOW()
          )
        ORDER BY occurred_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING
        id,
        aggregate_id,
        event_type,
        payload,
        attempts,
        occurred_at;
    `);

    return rows[0] ?? null;
  }

  private async publish(message: OutboxRow): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregate_id,
        MessageDeduplicationId: message.id,
      }),
    );
  }

  private async markPublished(id: string): Promise<void> {
    await this.em.fork().execute(
      `
      UPDATE outbox_messages
      SET
        published_at = NOW(),
        next_attempt_at = NULL
      WHERE id = ?
        AND published_at IS NULL;
      `,
      [id],
    );
  }

  private async scheduleRetry(id: string, attempts: number): Promise<void> {
    const seconds = Math.min(60, 2 ** Math.min(attempts, 6));

    await this.em.fork().execute(
      `
      UPDATE outbox_messages
      SET next_attempt_at =
        NOW() + (? * INTERVAL '1 second')
      WHERE id = ?
        AND published_at IS NULL;
      `,
      [seconds, id],
    );
  }

  private async runCycle(): Promise<void> {
    if (this.stopping || this.running) {
      return;
    }

    this.running = true;

    // Guarda a Promise para que o shutdown possa aguardá-la.
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
      for (let i = 0; i < 10; i++) {
        // Após o shutdown, não reserva outro evento.
        if (this.stopping) {
          break;
        }

        const message = await this.claimNext();

        if (!message) {
          break;
        }

        const startedAt = performance.now();

        try {
          // Um evento já reservado deve terminar sua tentativa.
          await this.publish(message);
          await this.markPublished(message.id);

          this.metrics.increment('outbox_events_published');

          const occurredAt = new Date(message.occurred_at).getTime();

          if (Number.isFinite(occurredAt)) {
            this.metrics.observe(
              'outbox_delay_ms',
              Math.max(0, Date.now() - occurredAt),
            );
          }

          this.logger.log({
            event: 'outbox_event_published',
            eventId: message.id,
            eventType: message.event_type,
            aggregateId: message.aggregate_id,
            attempts: message.attempts,
          });
        } catch (error) {
          this.metrics.increment('outbox_events_failed');

          this.logger.error({
            event: 'outbox_event_failed',
            eventId: message.id,
            eventType: message.event_type,
            aggregateId: message.aggregate_id,
            attempts: message.attempts,
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
          });

          try {
            await this.scheduleRetry(message.id, message.attempts);
          } catch (retryError) {
            this.logger.error({
              event: 'outbox_retry_scheduling_failed',
              eventId: message.id,
              error:
                retryError instanceof Error
                  ? retryError.message
                  : String(retryError),
              stack: retryError instanceof Error ? retryError.stack : undefined,
            });
          }
        } finally {
          this.metrics.observe(
            'outbox_publication_ms',
            performance.now() - startedAt,
          );
        }
      }
    } catch (error) {
      this.logger.error({
        event: 'outbox_publisher_cycle_failed',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
  }
}
