import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

@Injectable()
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly client: SQSClient;
  private readonly queueUrl: string;

  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly em: EntityManager) {
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

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.runCycle();
    }, 2000);

    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }

    this.client.destroy();
  }

  private async claimNext(): Promise<OutboxRow | null> {
    const em = this.em.fork();

    // A reserva é atômica e utiliza SKIP LOCKED.
    // Duas instâncias não recebem a mesma linha ao mesmo tempo.
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
        attempts;
    `);

    return rows[0] ?? null;
  }

  private async publish(message: OutboxRow) {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({
          eventId: message.id,
          eventType: message.event_type,
          payload: message.payload,
        }),
        MessageGroupId: message.aggregate_id,
        MessageDeduplicationId: message.id,
      }),
    );
  }

  private async markPublished(id: string) {
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

  private async scheduleRetry(id: string, attempts: number) {
    // Backoff: 2, 4, 8, 16... até 60 segundos.
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

  private async runCycle() {
    if (this.running) {
      return;
    }

    this.running = true;

    try {
      // Limita o trabalho de cada ciclo.
      for (let i = 0; i < 10; i++) {
        const message = await this.claimNext();

        if (!message) {
          break;
        }

        try {
          await this.publish(message);
          await this.markPublished(message.id);

          this.logger.log(`Published outbox event ${message.id}`);
        } catch (error) {
          this.logger.error(
            `Failed to publish event ${message.id}`,
            error instanceof Error ? error.stack : String(error),
          );

          try {
            await this.scheduleRetry(message.id, message.attempts);
          } catch (retryError) {
            this.logger.error(
              'Failed to schedule outbox retry',
              retryError instanceof Error
                ? retryError.stack
                : String(retryError),
            );
          }
        }
      }
    } catch (error) {
      this.logger.error(
        'Outbox publisher cycle failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }
}
